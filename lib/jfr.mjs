// JFR extraction helpers. Shells out to the `jfr` CLI (bundled with the JDK)
// to pull structured JSON for the event types we visualize, then reduces each
// stream into compact, chart-ready arrays.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// jfr JSON can be large (allocation/execution samples with full stack traces),
// so give the child a generous stdout buffer.
const MAX_BUFFER = 256 * 1024 * 1024;

/** Parse an ISO-8601 duration like "PT0.0033S" / "PT1M2.5S" into seconds. */
export function isoDurationToSeconds(s) {
    if (typeof s !== "string") return 0;
    const m = /^PT(?:(-?\d+(?:\.\d+)?)H)?(?:(-?\d+(?:\.\d+)?)M)?(?:(-?\d+(?:\.\d+)?)S)?$/.exec(s);
    if (!m) return 0;
    const h = parseFloat(m[1] || "0");
    const min = parseFloat(m[2] || "0");
    const sec = parseFloat(m[3] || "0");
    return h * 3600 + min * 60 + sec;
}

function toEpochMs(iso) {
    const t = Date.parse(iso);
    return Number.isNaN(t) ? 0 : t;
}

/** Run `jfr print --json --events <event> <file>` and return the events array. */
async function jfrEvents(jfrBin, file, events, extraArgs = []) {
    const args = ["print", "--json", "--events", events, ...extraArgs, file];
    const { stdout } = await execFileAsync(jfrBin, args, { maxBuffer: MAX_BUFFER });
    const parsed = JSON.parse(stdout);
    return parsed?.recording?.events ?? [];
}

/**
 * Like `jfrEvents` but strips stack traces (`--stack-depth 1`). Used for the
 * troubleshooting event streams we only aggregate (by monitor class, host, path,
 * …) — dropping the frames keeps the JSON tiny even for busy recordings. These
 * streams are also inherently bounded: contention and I/O events carry a 20 ms
 * `profile` threshold, so only genuinely slow operations are ever recorded.
 */
async function jfrPrint(jfrBin, file, events) {
    return jfrEvents(jfrBin, file, events, ["--stack-depth", "1"]);
}

/** Normalize a JFR class descriptor name ("java/lang/Object") to dotted form. */
function className(cls) {
    const n = cls && cls.name ? String(cls.name) : "";
    return n ? n.replace(/\//g, ".") : "unknown";
}

/**
 * Run `jfr view <view> <file>` and parse its fixed-width table. JFR views are
 * server-side aggregations, so their output is bounded regardless of how many
 * raw events the recording holds — unlike `jfr print`, which can emit gigabytes
 * for a long run and blow past any stdout buffer.
 *
 * Rows are parsed from the right: the trailing `numValueCols` whitespace-
 * delimited tokens are the value columns; everything before them is the label
 * (which may itself contain spaces, e.g. a method signature).
 *
 * @returns {Array<{label:string, values:string[]}>}
 */
async function jfrViewRows(jfrBin, file, view, numValueCols) {
    const { stdout } = await execFileAsync(
        jfrBin,
        ["view", "--width", "400", "--cell-height", "1", view, file],
        { maxBuffer: 32 * 1024 * 1024 },
    );
    const lines = stdout.split("\n");
    let started = false;
    const rows = [];
    for (const raw of lines) {
        const line = raw.replace(/\s+$/, "");
        if (!started) {
            // The dashed separator row marks the start of data.
            if (/^-{3,}(\s+-{3,})*\s*$/.test(line)) started = true;
            continue;
        }
        if (!line.trim()) break; // blank line ends the table
        const toks = line.trim().split(/\s+/);
        if (toks.length <= numValueCols) continue;
        const values = toks.slice(toks.length - numValueCols);
        const label = toks.slice(0, toks.length - numValueCols).join(" ");
        rows.push({ label, values });
    }
    return rows;
}

/** Parse a `jfr summary` table into a Map of event name → event count. */
async function jfrEventCounts(jfrBin, file) {
    const counts = new Map();
    try {
        const { stdout } = await execFileAsync(jfrBin, ["summary", file], { maxBuffer: 8 * 1024 * 1024 });
        for (const line of stdout.split("\n")) {
            const m = line.trim().match(/^(jdk\.\S+)\s+(\d+)\s+\d+/);
            if (m) counts.set(m[1], Number(m[2]));
        }
    } catch {}
    return counts;
}

const pctToNumber = (s) => {
    const n = parseFloat(String(s).replace("%", ""));
    return Number.isFinite(n) ? n : 0;
};

/**
 * Extract every JFR stream we care about and reduce it to chart-ready data.
 * All failures are tolerated: if `jfr` or an event stream is unavailable we
 * return what we have and mark the rest empty, so a partial recording still
 * renders.
 */
export async function extractJfr(jfrBin, file, { topN = 15 } = {}) {
    const out = {
        available: false,
        jvm: null,
        gcConfig: null,
        cpuLoad: [],
        heapSummary: [],
        collections: [],
        topAllocations: [],
        hotMethods: [],
        totalAllocatedMb: 0,
        sampleCount: 0,
        allocationSampleCount: 0,
        // --- Troubleshooting signals (beyond GC + CPU) --------------------
        contention: { available: false, count: 0, totalMs: 0, maxMs: 0, byMonitor: [] },
        safepoints: { available: false, count: 0, totalMs: 0, maxMs: 0, avgMs: 0 },
        exceptions: { available: false, total: 0, errors: 0, bySite: [] },
        threads: { available: false, timeline: [], peak: 0, current: 0 },
        io: {
            available: false,
            socketRead: { available: false, count: 0, totalMs: 0, bytes: 0, top: [] },
            socketWrite: { available: false, count: 0, totalMs: 0, bytes: 0, top: [] },
            fileRead: { available: false, count: 0, totalMs: 0, bytes: 0, top: [] },
            fileWrite: { available: false, count: 0, totalMs: 0, bytes: 0, top: [] },
        },
    };

    // Anchor all relative timestamps to the earliest event we observe.
    let originMs = Infinity;
    const rel = (iso) => {
        const ms = toEpochMs(iso);
        if (ms < originMs) originMs = ms;
        return ms;
    };

    // --- JVM information & GC configuration -------------------------------
    try {
        const [jvm] = await jfrEvents(jfrBin, file, "jdk.JVMInformation");
        if (jvm) {
            const v = jvm.values;
            out.jvm = {
                name: v.jvmName,
                version: v.jvmVersion,
                args: v.jvmArguments,
                javaArgs: v.javaArguments,
                pid: v.pid,
                startTime: v.jvmStartTime,
            };
        }
    } catch {}

    try {
        const [cfg] = await jfrEvents(jfrBin, file, "jdk.GCConfiguration");
        if (cfg) {
            const v = cfg.values;
            out.gcConfig = {
                youngCollector: v.youngCollector,
                oldCollector: v.oldCollector,
                parallelGCThreads: v.parallelGCThreads,
                concurrentGCThreads: v.concurrentGCThreads,
                usesDynamicGCThreads: v.usesDynamicGCThreads,
                gcTimeRatio: v.gcTimeRatio,
            };
        }
    } catch {}

    // --- CPU load over time -----------------------------------------------
    try {
        const events = await jfrEvents(jfrBin, file, "jdk.CPULoad");
        out.cpuLoad = events.map((e) => ({
            ms: rel(e.values.startTime),
            jvmUser: e.values.jvmUser,
            jvmSystem: e.values.jvmSystem,
            machineTotal: e.values.machineTotal,
        }));
    } catch {}

    // --- Heap occupancy samples -------------------------------------------
    try {
        const events = await jfrEvents(jfrBin, file, "jdk.GCHeapSummary");
        out.heapSummary = events.map((e) => ({
            ms: rel(e.values.startTime),
            gcId: e.values.gcId,
            when: e.values.when,
            usedMb: (e.values.heapUsed ?? 0) / (1024 * 1024),
            committedMb: (e.values.heapSpace?.committedSize ?? 0) / (1024 * 1024),
        }));
    } catch {}

    // --- Garbage collection pauses ----------------------------------------
    try {
        const events = await jfrEvents(jfrBin, file, "jdk.GarbageCollection");
        out.collections = events.map((e) => ({
            ms: rel(e.values.startTime),
            gcId: e.values.gcId,
            name: e.values.name,
            cause: e.values.cause,
            longestPauseMs: isoDurationToSeconds(e.values.longestPause) * 1000,
            sumOfPausesMs: isoDurationToSeconds(e.values.sumOfPauses) * 1000,
        }));
    } catch {}

    // Bounded, server-side aggregations (jfr view) rather than `jfr print`, so
    // a long recording with millions of samples can't overflow the buffer.
    const counts = await jfrEventCounts(jfrBin, file);
    out.sampleCount = counts.get("jdk.ExecutionSample") ?? 0;
    out.allocationSampleCount = counts.get("jdk.ObjectAllocationSample") ?? 0;

    // --- Top allocations (allocation pressure by class) -------------------
    // The view reports each class's share of total sampled allocation weight
    // ("Allocation Pressure %"). Absolute MB is reconstructed downstream from
    // GCToolkit's accurate allocation rate; the JFR stream alone can't give a
    // trustworthy absolute total for a sampled recording.
    try {
        const rows = await jfrViewRows(jfrBin, file, "allocation-by-class", 1);
        out.topAllocations = rows
            .map((r) => ({ name: r.label, pressurePct: pctToNumber(r.values[0]), weightMb: null }))
            .filter((a) => a.pressurePct > 0)
            .sort((a, b) => b.pressurePct - a.pressurePct)
            .slice(0, topN);
    } catch {}

    // --- Hot methods (execution-sample top frames) ------------------------
    try {
        const rows = await jfrViewRows(jfrBin, file, "hot-methods", 2);
        out.hotMethods = rows
            .map((r) => ({ name: r.label, samples: Number(r.values[0]) || 0, pct: pctToNumber(r.values[1]) }))
            .filter((m) => m.samples > 0)
            .sort((a, b) => b.samples - a.samples)
            .slice(0, topN);
    } catch {}

    // --- Lock contention (threads blocked entering a monitor) -------------
    // jdk.JavaMonitorEnter carries a `profile` threshold, so only genuinely
    // contended monitor-enters (default ≥ 20 ms blocked) are recorded. Aggregate
    // the blocked time by the monitor's class — the lock that hurts.
    try {
        const events = await jfrPrint(jfrBin, file, "jdk.JavaMonitorEnter");
        const byClass = new Map();
        let total = 0, max = 0;
        for (const e of events) {
            const v = e.values || {};
            const ms = isoDurationToSeconds(v.duration) * 1000;
            const cls = className(v.monitorClass);
            total += ms;
            if (ms > max) max = ms;
            const cur = byClass.get(cls) || { name: cls, count: 0, totalMs: 0, maxMs: 0 };
            cur.count += 1;
            cur.totalMs += ms;
            if (ms > cur.maxMs) cur.maxMs = ms;
            byClass.set(cls, cur);
        }
        const byMonitor = [...byClass.values()].sort((a, b) => b.totalMs - a.totalMs).slice(0, topN);
        out.contention = { available: events.length > 0, count: events.length, totalMs: total, maxMs: max, byMonitor };
    } catch {}

    // --- Safepoints (time-to-safepoint / stop-the-world synchronization) --
    // jdk.SafepointBegin's duration is the time spent bringing all threads to a
    // safepoint (TTSP). High values are latency the GC timeline never shows.
    try {
        const events = await jfrPrint(jfrBin, file, "jdk.SafepointBegin");
        let total = 0, max = 0;
        for (const e of events) {
            const ms = isoDurationToSeconds(e.values?.duration) * 1000;
            total += ms;
            if (ms > max) max = ms;
        }
        out.safepoints = {
            available: events.length > 0,
            count: events.length,
            totalMs: total,
            maxMs: max,
            avgMs: events.length ? total / events.length : 0,
        };
    } catch {}

    // --- Exceptions & errors ----------------------------------------------
    // jdk.ExceptionStatistics is a low-overhead periodic count of every
    // throwable created; the value is cumulative, so the last/max sample is the
    // run total. Top throw sites come from the bounded `exception-by-site` view.
    try {
        const stats = await jfrPrint(jfrBin, file, "jdk.ExceptionStatistics");
        const total = stats.reduce((m, e) => Math.max(m, Number(e.values?.throwables) || 0), 0);
        const errors = counts.get("jdk.JavaErrorThrow") ?? 0;
        let bySite = [];
        try {
            const rows = await jfrViewRows(jfrBin, file, "exception-by-site", 1);
            bySite = rows
                .map((r) => ({ name: r.label, count: Number(r.values[0]) || 0 }))
                .filter((x) => x.count > 0)
                .slice(0, topN);
        } catch {}
        out.exceptions = { available: total > 0 || errors > 0 || bySite.length > 0, total, errors, bySite };
    } catch {}

    // --- Thread population over time --------------------------------------
    try {
        const events = await jfrPrint(jfrBin, file, "jdk.JavaThreadStatistics");
        out.threads.timeline = events.map((e) => ({
            ms: rel(e.values.startTime),
            active: e.values.activeCount,
            daemon: e.values.daemonCount,
            peak: e.values.peakCount,
        }));
        out.threads.peak = events.reduce((m, e) => Math.max(m, e.values.peakCount || 0), 0);
        out.threads.current = events.length ? events[events.length - 1].values.activeCount : 0;
        out.threads.available = events.length > 0;
    } catch {}

    // --- Slow I/O (socket + file) -----------------------------------------
    // These streams also carry a `profile` threshold, so only slow operations
    // (default ≥ 20 ms) appear — exactly the ones worth troubleshooting.
    const aggregateIo = async (event, keyField, bytesField) => {
        const res = { available: false, count: 0, totalMs: 0, bytes: 0, top: [] };
        try {
            const events = await jfrPrint(jfrBin, file, event);
            const byKey = new Map();
            for (const e of events) {
                const v = e.values || {};
                const ms = isoDurationToSeconds(v.duration) * 1000;
                const key = v[keyField] ? String(v[keyField]) : "unknown";
                const b = Number(v[bytesField]) || 0;
                res.count += 1;
                res.totalMs += ms;
                res.bytes += b;
                const cur = byKey.get(key) || { name: key, count: 0, totalMs: 0, bytes: 0 };
                cur.count += 1;
                cur.totalMs += ms;
                cur.bytes += b;
                byKey.set(key, cur);
            }
            res.top = [...byKey.values()].sort((a, b) => b.totalMs - a.totalMs).slice(0, topN);
            res.available = events.length > 0;
        } catch {}
        return res;
    };
    out.io.socketRead = await aggregateIo("jdk.SocketRead", "host", "bytesRead");
    out.io.socketWrite = await aggregateIo("jdk.SocketWrite", "host", "bytesWritten");
    out.io.fileRead = await aggregateIo("jdk.FileRead", "path", "bytesRead");
    out.io.fileWrite = await aggregateIo("jdk.FileWrite", "path", "bytesWritten");
    out.io.available =
        out.io.socketRead.available || out.io.socketWrite.available ||
        out.io.fileRead.available || out.io.fileWrite.available;

    // Normalize relative timestamps to seconds from the recording origin.
    if (Number.isFinite(originMs)) {
        const norm = (arr) => arr.forEach((d) => { d.t = Math.max(0, (d.ms - originMs) / 1000); delete d.ms; });
        norm(out.cpuLoad);
        norm(out.heapSummary);
        norm(out.collections);
        norm(out.threads.timeline);
    }

    out.available =
        out.cpuLoad.length > 0 ||
        out.heapSummary.length > 0 ||
        out.collections.length > 0 ||
        out.topAllocations.length > 0 ||
        out.hotMethods.length > 0 ||
        out.contention.available ||
        out.safepoints.available ||
        out.exceptions.available ||
        out.threads.available ||
        out.io.available;

    return out;
}
