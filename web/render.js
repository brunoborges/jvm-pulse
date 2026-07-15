"use strict";

// ---------------------------------------------------------------------------
// Small SVG charting toolkit (no dependencies). Every helper returns an SVG
// string sized to a fixed viewBox and scaled to container width via CSS.
// ---------------------------------------------------------------------------
const NS = "http://www.w3.org/2000/svg";
const fmt = (n, d = 1) => (n == null || Number.isNaN(n) ? "–" : Number(n).toLocaleString(undefined, { maximumFractionDigits: d }));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const TYPE_COLORS = {
  Young: "var(--gc-young)",
  G1GCYoungInitialMark: "var(--gc-young)",
  Initial: "var(--gc-young)",
  Mixed: "var(--gc-mixed)",
  G1GCRemark: "var(--gc-mixed)",
  Remark: "var(--gc-mixed)",
  Full: "var(--gc-old)",
  SystemGC: "var(--gc-system)",
};
const colorForType = (t) => TYPE_COLORS[t] || "var(--accent)";
const PALETTE = ["#2563eb", "#7c3aed", "#059669", "#d97706", "#dc2626", "#0891b2", "#4f46e5", "#db2777", "#65a30d", "#0d9488", "#9333ea", "#ea580c"];

function niceTicks(min, max, count = 5) {
  if (min === max) { max = min + 1; }
  const span = max - min;
  const step = Math.pow(10, Math.floor(Math.log10(span / count)));
  const err = (count * step) / span;
  let mult = 1;
  if (err <= 0.15) mult = 10; else if (err <= 0.35) mult = 5; else if (err <= 0.75) mult = 2;
  const s = mult * step;
  const ticks = [];
  for (let v = Math.ceil(min / s) * s; v <= max + 1e-9; v += s) ticks.push(v);
  return ticks;
}

// Generic Cartesian frame builder. Returns { body, px, py } with scale fns.
function frame({ w = 560, h = 240, xmin, xmax, ymin, ymax, xlabel, ylabel, yfmt = (v) => fmt(v, 0) }) {
  const m = { l: 54, r: 14, t: 12, b: 34 };
  const iw = w - m.l - m.r;
  const ih = h - m.t - m.b;
  const px = (x) => m.l + (xmax === xmin ? 0 : ((x - xmin) / (xmax - xmin)) * iw);
  const py = (y) => m.t + ih - (ymax === ymin ? 0 : ((y - ymin) / (ymax - ymin)) * ih);
  let g = "";
  for (const yt of niceTicks(ymin, ymax)) {
    const y = py(yt);
    g += `<line class="grid-line" x1="${m.l}" y1="${y.toFixed(1)}" x2="${m.l + iw}" y2="${y.toFixed(1)}"/>`;
    g += `<text class="tick" x="${m.l - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end">${esc(yfmt(yt))}</text>`;
  }
  for (const xt of niceTicks(xmin, xmax)) {
    const x = px(xt);
    g += `<text class="tick" x="${x.toFixed(1)}" y="${h - m.b + 16}" text-anchor="middle">${esc(fmt(xt, 0))}</text>`;
  }
  g += `<line class="axis" x1="${m.l}" y1="${m.t}" x2="${m.l}" y2="${m.t + ih}"/>`;
  g += `<line class="axis" x1="${m.l}" y1="${m.t + ih}" x2="${m.l + iw}" y2="${m.t + ih}"/>`;
  if (xlabel) g += `<text class="axis-label" x="${m.l + iw / 2}" y="${h - 2}" text-anchor="middle">${esc(xlabel)}</text>`;
  if (ylabel) g += `<text class="axis-label" x="12" y="${m.t + ih / 2}" text-anchor="middle" transform="rotate(-90 12 ${m.t + ih / 2})">${esc(ylabel)}</text>`;
  return { g, px, py, w, h, m, iw, ih };
}

function svgWrap(w, h, inner) {
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" role="img">${inner}</svg>`;
}

let gradSeq = 0;

// Scatter of GC pauses over time, colored by collection type.
function scatterPauses(events, { w = 560, h = 240 } = {}) {
  if (!events.length) return emptyChart(w, h);
  const xmax = Math.max(...events.map((e) => e.t), 1);
  const ymax = Math.max(...events.map((e) => e.durationMs), 1) * 1.05;
  const f = frame({ w, h, xmin: 0, xmax, ymin: 0, ymax, xlabel: "Time (s)", ylabel: "Pause (ms)", yfmt: (v) => fmt(v, 1) });
  let dots = "";
  for (const e of events) {
    dots += `<circle class="dot" cx="${f.px(e.t).toFixed(1)}" cy="${f.py(e.durationMs).toFixed(1)}" r="3" fill="${colorForType(e.type)}" fill-opacity="0.72"><title>${esc(e.type)} · ${esc(e.cause)} · ${fmt(e.durationMs, 2)} ms @ ${fmt(e.t, 2)}s</title></circle>`;
  }
  return svgWrap(w, h, f.g + dots);
}

// Multi-series line chart. series: [{name,color,points:[{t,v}]}]
function lineChart(series, { w = 560, h = 240, xlabel = "Time (s)", ylabel = "", yfmt = (v) => fmt(v, 0), ymaxForce } = {}) {
  const all = series.flatMap((s) => s.points);
  if (!all.length) return emptyChart(w, h);
  const xmax = Math.max(...all.map((p) => p.t), 1);
  const ymax = ymaxForce != null ? ymaxForce : Math.max(...all.map((p) => p.v), 1) * 1.05;
  const f = frame({ w, h, xmin: 0, xmax, ymin: 0, ymax, xlabel, ylabel, yfmt });
  let lines = "";
  for (const s of series) {
    if (!s.points.length) continue;
    const d = s.points.map((p, i) => `${i ? "L" : "M"}${f.px(p.t).toFixed(1)},${f.py(p.v).toFixed(1)}`).join(" ");
    lines += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="1.6"/>`;
  }
  return svgWrap(w, h, f.g + lines);
}

// Area chart of heap occupancy after each GC (with committed size line).
function heapArea(events, { w = 560, h = 240 } = {}) {
  const pts = events.filter((e) => e.heapAfterKb >= 0);
  if (!pts.length) return emptyChart(w, h);
  const xmax = Math.max(...pts.map((e) => e.t), 1);
  const ymax = Math.max(...pts.map((e) => Math.max(e.heapBeforeKb, e.heapSizeKb))) / 1024 * 1.05;
  const f = frame({ w, h, xmin: 0, xmax, ymin: 0, ymax, xlabel: "Time (s)", ylabel: "Heap (MB)", yfmt: (v) => fmt(v, 0) });
  const gid = `heapgrad${++gradSeq}`;
  const beforeLine = pts.map((e, i) => `${i ? "L" : "M"}${f.px(e.t).toFixed(1)},${f.py(e.heapBeforeKb / 1024).toFixed(1)}`).join(" ");
  const afterD = pts.map((e, i) => `${i ? "L" : "M"}${f.px(e.t).toFixed(1)},${f.py(e.heapAfterKb / 1024).toFixed(1)}`).join(" ");
  const areaD = `${afterD} L${f.px(pts[pts.length - 1].t).toFixed(1)},${f.py(0).toFixed(1)} L${f.px(pts[0].t).toFixed(1)},${f.py(0).toFixed(1)} Z`;
  const defs = `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--gc-young)" stop-opacity="0.28"/><stop offset="100%" stop-color="var(--gc-young)" stop-opacity="0.02"/></linearGradient></defs>`;
  const area = `<path d="${areaD}" fill="url(#${gid})"/>`;
  const after = `<path d="${afterD}" fill="none" stroke="var(--gc-young)" stroke-width="1.6"/>`;
  const before = `<path d="${beforeLine}" fill="none" stroke="var(--gc-old)" stroke-width="1" stroke-opacity="0.6" stroke-dasharray="3 3"/>`;
  return svgWrap(w, h, defs + f.g + area + after + before);
}

function emptyChart(w, h) {
  return svgWrap(w, h, `<text x="${w / 2}" y="${h / 2}" text-anchor="middle" class="tick">No data</text>`);
}

// Horizontal bar list rendered as HTML (better label handling than SVG).
// items: [{ name, label, value, sub?, owner?, color? }]. Fills animate from 0
// via CSS once the `--w` target is applied by animateBars().
function barList(items, { max, valueFmt = (v) => fmt(v, 1), unit = "", colorBy, ranked = false } = {}) {
  const m = max ?? Math.max(...items.map((i) => i.value), 1);
  return `<div class="barrow">` + items.map((it, idx) => {
    const pct = Math.max(1.5, (it.value / m) * 100);
    const color = it.color || (colorBy ? colorBy(it, idx) : "var(--accent)");
    const rank = ranked ? `<span class="rank">${idx + 1}</span>` : `<span class="rank"></span>`;
    const owner = it.owner ? `<span class="owner">${esc(it.owner)}</span>` : "";
    const sub = it.sub ? `<span class="sub">${esc(it.sub)}</span>` : "";
    return `<div class="bar-item">${rank}` +
      `<span class="name" title="${esc(it.name)}">${owner}<span>${esc(it.label ?? it.name)}</span></span>` +
      `<span class="track"><span class="fill" data-w="${pct.toFixed(1)}" style="background:${color}"></span></span>` +
      `<span class="val">${esc(valueFmt(it.value))}${unit}${sub}</span></div>`;
  }).join("") + `</div>`;
}

// Apply target widths after the markup is in the DOM so the CSS width
// transition animates from 0. Called by showReport().
function animateBars(root) {
  const fills = (root || document).querySelectorAll(".bar-item .fill[data-w]");
  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) { fills.forEach((f) => (f.style.width = f.dataset.w + "%")); return; }
  requestAnimationFrame(() => requestAnimationFrame(() => {
    fills.forEach((f) => (f.style.width = f.dataset.w + "%"));
  }));
}

function legend(items) {
  return `<div class="legend">` + items.map((i) => `<span class="item"><span class="swatch" style="background:${i.color}"></span>${esc(i.label)}</span>`).join("") + `</div>`;
}

// ---------------------------------------------------------------------------
// Rendering the report
// ---------------------------------------------------------------------------

// Human-friendly memory: promote MB to GB past 1024 so "25.8 GB" beats "25,757 MB".
function humanBytesMb(mb, d = 1) {
  if (mb == null || Number.isNaN(mb)) return "–";
  if (mb >= 1024) return `${fmt(mb / 1024, d)} GB`;
  if (mb >= 1) return `${fmt(mb, mb < 10 ? 1 : 0)} MB`;
  return `${fmt(mb * 1024, 0)} KB`;
}

// Human-friendly byte counts from a raw byte value.
function humanBytes(b, d = 1) {
  if (b == null || Number.isNaN(b)) return "–";
  if (b >= 1 << 30) return `${fmt(b / (1 << 30), d)} GB`;
  if (b >= 1 << 20) return `${fmt(b / (1 << 20), d)} MB`;
  if (b >= 1024) return `${fmt(b / 1024, 0)} KB`;
  return `${fmt(b, 0)} B`;
}

// Format a millisecond duration, promoting to seconds past 1 s.
function humanMs(v, d = 0) {
  if (v == null || Number.isNaN(v)) return "–";
  return v >= 1000 ? `${fmt(v / 1000, 2)} s` : `${fmt(v, d)} ms`;
}

const worseOf = (a, b) => (["good", "warn", "bad", "neutral"].indexOf(b) > ["good", "warn", "bad", "neutral"].indexOf(a) && b !== "neutral" ? b : a);
const band = (v, goodBelow, warnBelow) => (v == null ? "neutral" : v < goodBelow ? "good" : v <= warnBelow ? "warn" : "bad");
const bandAbove = (v, goodAbove, warnAbove) => (v == null ? "neutral" : v >= goodAbove ? "good" : v >= warnAbove ? "warn" : "bad");
const STATUS_COLOR = { good: "var(--status-good)", warn: "var(--status-warn)", bad: "var(--status-bad)", neutral: "var(--status-neutral)" };
const isJdk = (name) => /^(java|javax|jdk|sun|com\.sun|jakarta|kotlin|scala|groovy|org\.graalvm|com\.oracle)\./.test(name);

// The dashboard's point of view: assess GC health and name the main lever.
function assess(s, jfr) {
  const tp = s.throughputPercent, p99 = s.p99PauseMs, mx = s.maxPauseMs, ar = s.allocRateMbPerSec;
  const tpS = bandAbove(tp, 95, 90);
  const p99S = band(p99, 20, 50);
  const mxS = band(mx, 50, 150);
  const arS = band(ar, 64, 256);
  const peakRatio = s.maxHeapSizeKb ? (s.peakHeapKb || 0) / s.maxHeapSizeKb : null;
  const heapS = peakRatio == null ? "neutral" : peakRatio > 0.92 ? "warn" : "neutral";
  const overall = worseOf(worseOf(tpS, p99S), mxS);
  return { tp, p99, mx, ar, tpS, p99S, mxS, arS, heapS, overall };
}

function verdictBlock(a, s, jfr) {
  const headline = {
    good: "Garbage collection is healthy",
    warn: "Garbage collection needs a look",
    bad: "Garbage collection is a bottleneck",
    neutral: "Garbage collection profile",
  }[a.overall];

  let detail = `${fmt(a.tp, 1)}% throughput`;
  if (a.p99 != null) detail += `, p99 pause ${fmt(a.p99, 1)} ms`;
  detail += a.overall === "good" ? " — GC is not the bottleneck."
    : a.overall === "warn" ? " — there's pause or throughput headroom to reclaim."
    : " — pauses or low throughput are hurting the workload.";
  if (a.ar != null) {
    const churn = jfr && jfr.totalAllocatedMb ? ` (≈ ${humanBytesMb(jfr.totalAllocatedMb)} churned)` : "";
    detail += a.arS === "good"
      ? ` Allocation pressure is low at ${fmt(a.ar, 0)} MB/s.`
      : ` Allocation pressure is ${a.arS === "warn" ? "elevated" : "high"} at ${fmt(a.ar, 0)} MB/s${churn} — the main lever for further gains.`;
  }

  const chips = [];
  const chip = (k, v, st) => `<span class="chip"><span class="dot" style="background:${STATUS_COLOR[st]}"></span><span class="chip-k">${esc(k)}</span> <b>${esc(v)}</b></span>`;
  chips.push(chip("Throughput", `${fmt(a.tp, 1)}%`, a.tpS));
  if (a.p99 != null) chips.push(chip("p99 pause", `${fmt(a.p99, 1)} ms`, a.p99S));
  if (a.ar != null) chips.push(chip("Alloc", `${fmt(a.ar, 0)} MB/s`, a.arS));
  const top = jfr && jfr.topAllocations && jfr.topAllocations[0];
  if (top) chips.push(chip("Top type", `${shortClass(top.name)} ${fmt(top.pressurePct, 0)}%`, "neutral"));
  const c = jfr && jfr.contention;
  if (c && c.available && c.totalMs > 50) {
    const frac = s.runtimeSec ? c.totalMs / 1000 / s.runtimeSec : null;
    chips.push(chip("Lock wait", humanMs(c.totalMs), band(frac, 0.05, 0.2)));
  }

  return `<div class="verdict reveal" data-status="${a.overall}" style="--i:0">
    <span class="badge"><span class="dot"></span>${a.overall === "good" ? "Healthy" : a.overall === "warn" ? "Attention" : a.overall === "bad" ? "Critical" : "Profile"}</span>
    <div class="vbody">
      <p class="headline">${esc(headline)}</p>
      <p class="detail">${esc(detail)}</p>
      <div class="chips">${chips.join("")}</div>
    </div>
  </div>`;
}

function kpiTile(label, value, unit, status, tag, sub) {
  return `<div class="kpi" data-status="${status}">
    <div class="khead"><span class="klabel">${esc(label)}</span>${tag ? `<span class="ktag">${esc(tag)}</span>` : ""}</div>
    <div class="kvalue">${esc(value)}${unit ? `<span class="unit">${esc(unit)}</span>` : ""}</div>
    ${sub ? `<div class="ksub">${esc(sub)}</div>` : ""}
  </div>`;
}

function subStat(label, value, unit) {
  return `<div class="substat"><div class="label">${esc(label)}</div><div class="value">${esc(value)}${unit ? `<span class="unit">${esc(unit)}</span>` : ""}</div></div>`;
}

function sectionHeader(title, count) {
  return `<div class="section"><h2>${esc(title)}</h2><span class="rule"></span>${count != null ? `<span class="count">${esc(count)}</span>` : ""}</div>`;
}

// Build the troubleshooting panels beyond GC: lock contention, safepoints,
// exceptions, thread population, and slow I/O — all sourced from JFR. Each panel
// is only produced when its signal is present in the recording.
function signalPanels(jfr, s) {
  const panels = [];

  // Lock contention — threads blocked entering a monitor, by lock class.
  const c = jfr.contention;
  if (c && c.available && c.byMonitor && c.byMonitor.length) {
    const items = c.byMonitor.map((m) => ({
      name: m.name,
      label: shortClass(m.name),
      value: m.totalMs,
      sub: `${fmt(m.count, 0)}×`,
      color: "var(--gc-old)",
    }));
    panels.push(panel("Lock contention",
      `Threads blocked entering monitors: ${fmt(c.count, 0)} events, ${humanMs(c.totalMs)} total blocked, max ${humanMs(c.maxMs)}. By lock class.`,
      barList(items, { ranked: true, valueFmt: (v) => humanMs(v) }), "wide"));
  }

  // Safepoints — time-to-safepoint synchronization latency (not GC work).
  const sp = jfr.safepoints;
  if (sp && sp.available) {
    const body = `<div class="substats">` + [
      subStat("Safepoints", fmt(sp.count, 0)),
      subStat("Total TTSP", fmt(sp.totalMs, 1), "ms"),
      subStat("Max TTSP", fmt(sp.maxMs, 2), "ms"),
      subStat("Avg TTSP", fmt(sp.avgMs, 3), "ms"),
    ].join("") + `</div>`;
    panels.push(panel("Safepoints", "Time-to-safepoint — stop-the-world synchronization latency the GC timeline doesn't show.", body));
  }

  // Exceptions & errors — throwables created, with top throw sites.
  const ex = jfr.exceptions;
  if (ex && ex.available) {
    const stats = `<div class="substats">` + [
      subStat("Throwables", fmt(ex.total, 0)),
      subStat("Errors", fmt(ex.errors, 0)),
    ].join("") + `</div>`;
    let sites = "";
    if (ex.bySite && ex.bySite.length) {
      const items = ex.bySite.map((x) => ({
        name: x.name,
        label: shortMethod(x.name),
        value: x.count,
        owner: isJdk(x.name) ? "" : "App",
        color: isJdk(x.name) ? "var(--status-neutral)" : "var(--accent)",
      }));
      sites = barList(items, { ranked: true, valueFmt: (v) => fmt(v, 0) });
    }
    panels.push(panel("Exceptions & errors", "Throwables created during the run, with the top throw sites (JFR).", stats + sites));
  }

  // Threads — live population over the run.
  const th = jfr.threads;
  if (th && th.available && th.timeline && th.timeline.length) {
    const chart = lineChart([
      { name: "active", color: "var(--accent)", points: th.timeline.map((d) => ({ t: d.t, v: d.active })) },
      { name: "peak", color: "var(--gc-old)", points: th.timeline.map((d) => ({ t: d.t, v: d.peak })) },
    ], { ylabel: "Threads", yfmt: (v) => fmt(v, 0) }) + legend([
      { color: "var(--accent)", label: "Active" },
      { color: "var(--gc-old)", label: "Peak" },
    ]);
    panels.push(panel("Threads", `Live thread count over the run — peak ${fmt(th.peak, 0)}, ${fmt(th.current, 0)} at end.`, chart));
  }

  // Slow I/O — blocking socket/file ops over the JFR threshold, by endpoint.
  const io = jfr.io;
  if (io && io.available) {
    const rows = [];
    const add = (kind, agg, color) => {
      if (!agg || !agg.available) return;
      for (const t of agg.top) {
        const short = t.name.includes("/") ? t.name.split("/").filter(Boolean).pop() : t.name;
        rows.push({
          name: `${kind}: ${t.name}`,
          label: `${kind} · ${short}`,
          value: t.totalMs,
          sub: `${humanBytes(t.bytes)} · ${fmt(t.count, 0)}×`,
          color,
        });
      }
    };
    add("Socket read", io.socketRead, "var(--gc-young)");
    add("Socket write", io.socketWrite, "var(--gc-mixed)");
    add("File read", io.fileRead, "var(--gc-system)");
    add("File write", io.fileWrite, "var(--gc-old)");
    rows.sort((a, b) => b.value - a.value);
    const items = rows.slice(0, 12);
    if (items.length) {
      const totalMs = io.socketRead.totalMs + io.socketWrite.totalMs + io.fileRead.totalMs + io.fileWrite.totalMs;
      panels.push(panel("Slow I/O",
        `Blocking socket/file operations over the JFR threshold: ${humanMs(totalMs)} total. By endpoint/path.`,
        barList(items, { ranked: true, valueFmt: (v) => humanMs(v) }), "wide"));
    }
  }

  return panels;
}

function renderReport(r) {
  const gc = r.gc || {};
  const s = gc.summary || {};
  const jfr = r.jfr || {};
  const out = [];

  if (gc.error) out.push(`<div class="error-banner"><strong>GC log analysis error.</strong> ${esc(gc.error)}</div>`);

  out.push(runMetaLine(r));

  const a = assess(s, jfr);

  // 1. Verdict — lead with a point of view.
  if (s.throughputPercent != null) out.push(verdictBlock(a, s, jfr));

  // 2. Primary KPIs — the four metrics that decide GC health.
  const tagTp = { good: "Healthy", warn: "Fair", bad: "Poor", neutral: "" }[a.tpS];
  const tagP99 = { good: "Tight", warn: "Elevated", bad: "High", neutral: "" }[a.p99S];
  const tagAr = { good: "Low", warn: "Elevated", bad: "High", neutral: "" }[a.arS];
  const maxHeapMb = (s.maxHeapSizeKb || 0) / 1024;
  out.push(`<div class="kpis reveal" style="--i:1">` + [
    kpiTile("Throughput", fmt(s.throughputPercent, 2), "%", a.tpS, tagTp, `${fmt(s.percentPaused, 2)}% of time in GC`),
    kpiTile("p99 pause", fmt(s.p99PauseMs, 1), "ms", a.p99S, tagP99, `max ${fmt(s.maxPauseMs, 1)} ms`),
    kpiTile("Alloc rate", fmt(s.allocRateMbPerSec, 0), "MB/s", a.arS, tagAr, jfr.totalAllocatedMb ? `≈ ${humanBytesMb(jfr.totalAllocatedMb)} churned` : "sustained"),
    kpiTile("Peak heap", fmt((s.peakHeapKb || 0) / 1024, 0), "MB", a.heapS, "", maxHeapMb ? `of ${fmt(maxHeapMb, 0)} MB max` : "committed"),
  ].join("") + `</div>`);

  // Secondary stats — supporting detail, denser.
  out.push(`<div class="substats reveal" style="--i:2">` + [
    subStat("GC events", fmt(s.eventCount, 0)),
    subStat("Total pause", fmt(s.totalPauseMs, 0), "ms"),
    subStat("Avg pause", fmt(s.avgPauseMs, 2), "ms"),
    subStat("GC runtime", fmt(s.runtimeSec, 1), "s"),
  ].join("") + `</div>`);

  // 3. Charts
  const panels = [];
  panels.push(panel("GC pause timeline", "Every stop-the-world pause, colored by collection type.",
    scatterPauses(gc.events || []) + typeLegend(gc.types || {})));

  panels.push(panel("Heap occupancy", "Heap used after each GC (solid) vs. before (dashed).",
    heapArea(gc.events || []) + legend([
      { color: "var(--gc-young)", label: "After GC" },
      { color: "var(--gc-old)", label: "Before GC" },
    ])));

  const causeItems = Object.entries(gc.causes || {}).map(([name, value]) => ({ name, label: name, value })).sort((x, y) => y.value - x.value);
  panels.push(panel("GC cause breakdown", "Collections triggered by each cause.",
    causeItems.length ? barList(causeItems, { valueFmt: (v) => fmt(v, 0), colorBy: (_, i) => PALETTE[i % PALETTE.length] }) : emptyChart(560, 120)));

  if (jfr.cpuLoad && jfr.cpuLoad.length) {
    panels.push(panel("CPU load", "JVM vs. machine CPU utilization over the run (JFR).",
      lineChart([
        { name: "jvmUser", color: "var(--gc-young)", points: jfr.cpuLoad.map((d) => ({ t: d.t, v: d.jvmUser * 100 })) },
        { name: "jvmSystem", color: "var(--gc-system)", points: jfr.cpuLoad.map((d) => ({ t: d.t, v: d.jvmSystem * 100 })) },
        { name: "machineTotal", color: "var(--status-neutral)", points: jfr.cpuLoad.map((d) => ({ t: d.t, v: d.machineTotal * 100 })) },
      ], { ylabel: "CPU (%)", yfmt: (v) => fmt(v, 0), ymaxForce: 100 }) + legend([
        { color: "var(--gc-young)", label: "JVM user" },
        { color: "var(--gc-system)", label: "JVM system" },
        { color: "var(--status-neutral)", label: "Machine total" },
      ])));
  }

  if (jfr.heapSummary && jfr.heapSummary.length) {
    panels.push(panel("Heap used (JFR)", "Fine-grained heap sampled around every GC id.",
      lineChart([
        { name: "used", color: "var(--accent)", points: jfr.heapSummary.map((d) => ({ t: d.t, v: d.usedMb })) },
        { name: "committed", color: "var(--status-neutral)", points: jfr.heapSummary.map((d) => ({ t: d.t, v: d.committedMb })) },
      ], { ylabel: "Heap (MB)" }) + legend([
        { color: "var(--accent)", label: "Used" },
        { color: "var(--status-neutral)", label: "Committed" },
      ])));
  }

  // Top allocations — where the memory churn goes (the lever).
  if (jfr.topAllocations && jfr.topAllocations.length) {
    const items = jfr.topAllocations.map((al) => ({
      name: al.name,
      label: shortClass(al.name),
      value: al.weightMb != null ? al.weightMb : al.pressurePct,
      sub: al.weightMb != null && al.pressurePct != null ? `${fmt(al.pressurePct, 1)}%` : "",
      color: "var(--gc-system)",
    }));
    const useBytes = jfr.topAllocations[0].weightMb != null;
    const desc = jfr.totalAllocatedMb
      ? `By share of allocation pressure. Total ≈ ${humanBytesMb(jfr.totalAllocatedMb)} churned.`
      : "By share of allocation pressure (JFR sampling).";
    panels.push(panel("Top allocations", desc,
      barList(items, { ranked: true, valueFmt: useBytes ? (v) => humanBytesMb(v) : (v) => fmt(v, 1) + "%" })));
  }

  // Hot methods — self time, with your code called out from JDK internals.
  if (jfr.hotMethods && jfr.hotMethods.length) {
    const items = jfr.hotMethods.map((mth) => {
      const app = !isJdk(mth.name);
      return {
        name: mth.name,
        label: shortMethod(mth.name),
        value: mth.pct,
        sub: mth.samples != null ? `${fmt(mth.samples, 0)} smpl` : "",
        owner: app ? "App" : "",
        color: app ? "var(--accent)" : "var(--status-neutral)",
      };
    });
    panels.push(panel("Hot methods", `Top self-time methods from ${fmt(jfr.sampleCount, 0)} execution samples. App code highlighted.`,
      barList(items, { ranked: true, valueFmt: (v) => fmt(v, 1), unit: "%", max: Math.max(items[0].value * 1.05, 10) }), "wide"));
  }

  out.push(sectionHeader("Charts", `${panels.length} panels`));
  out.push(`<div class="panels">` + panels.map((p, i) =>
    p.replace('<div class="panel ', `<div style="--i:${Math.min(i + 3, 9)}" class="panel reveal `)
  ).join("") + `</div>`);

  // 3b. Concurrency, threads & I/O — troubleshooting signals from JFR beyond GC.
  const sigPanels = signalPanels(jfr, s);
  if (sigPanels.length) {
    out.push(sectionHeader("Concurrency, threads & I/O", `${sigPanels.length} panels`));
    out.push(`<div class="panels">` + sigPanels.map((p, i) =>
      p.replace('<div class="panel ', `<div style="--i:${Math.min(i + 3, 9)}" class="panel reveal `)
    ).join("") + `</div>`);
  }

  // 4. Environment
  const jvm = r.jvm || {};
  const cfg = r.gcConfig || {};
  const infoRows = [
    ["Collector", cfg.youngCollector ? `${cfg.youngCollector} / ${cfg.oldCollector}` : "–"],
    ["JVM", jvm.name || "–"],
    ["Version", (jvm.version || "").split(" for ")[0] || "–"],
    ["GC threads", cfg.parallelGCThreads != null ? `${cfg.parallelGCThreads} parallel · ${cfg.concurrentGCThreads} concurrent` : "–"],
    ["Java args", jvm.javaArgs || "–"],
    ["Workload", r.label || "–"],
    ["GC log", (r.source && r.source.gcLogName) || "–"],
  ];
  out.push(sectionHeader("Environment"));
  const envPanels = [];
  if (r.command) envPanels.push(commandPanel(r.command));
  envPanels.push(panel("", "", `<table class="info">${infoRows.map(([k, v]) => `<tr><td class="k">${esc(k)}</td><td class="v">${esc(v)}</td></tr>`).join("")}</table>`, "wide"));
  out.push(`<div class="panels">` + envPanels.join("") + `</div>`);

  let html = out.join("");
  if (r.artifacts && r.artifacts.views) {
    html += `<details class="views"><summary>Raw <code>jfr view all-views</code> report</summary><pre id="views-pre">Loading…</pre></details>`;
  }
  return html;
}

function panel(title, desc, body, extraClass = "") {
  const head = title ? `<div class="phead"><h3>${esc(title)}</h3></div>` : "";
  const d = desc ? `<p class="desc">${esc(desc)}</p>` : "";
  return `<div class="panel ${extraClass}">${head}${d}${body}</div>`;
}

// A concise timestamp for a run, e.g. "Jul 7, 14:32".
function fmtRunTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Identity line at the top of a report: which run is on screen.
function runMetaLine(r) {
  if (!r || (!r.generatedAt && !r.label && !r.runId)) return "";
  const when = fmtRunTime(r.generatedAt) || esc(r.runId || "");
  const label = r.label ? `<span class="rm-label">${esc(r.label)}</span>` : "";
  return `<div class="runmeta reveal" style="--i:0">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
    <span class="rm-when">${esc(when)}</span>${label}
  </div>`;
}

// The exact launch command (with JVM flags) for a run, monospace + copyable.
function commandPanel(command) {
  return `<div class="panel wide cmd-panel">
    <div class="phead"><h3>Command</h3><button class="btn copy-cmd" type="button" data-cmd="${esc(command)}">Copy</button></div>
    <p class="desc">The exact command and JVM flags used to launch this workload.</p>
    <pre class="cmd">${esc(command)}</pre>
  </div>`;
}

function typeLegend(types) {
  const items = Object.keys(types).map((t) => ({ color: colorForType(t), label: `${t} (${types[t]})` }));
  return legend(items);
}

function shortClass(name) {
  let n = String(name).replace(/^\[+L?/, "").replace(/;$/, "");
  const parts = n.split(".");
  return parts.length > 2 ? parts.slice(-2).join(".") : n;
}
function shortMethod(name) {
  const paren = name.indexOf("(");
  const head = paren >= 0 ? name.slice(0, paren) : name;
  const args = paren >= 0 ? name.slice(paren) : "";
  const dot = head.lastIndexOf(".");
  const cls = head.slice(0, dot);
  const method = head.slice(dot + 1);
  const clsParts = cls.split(".");
  return `${clsParts[clsParts.length - 1] || cls}.${method}${args ? "()" : ""}`;
}

// ---------------------------------------------------------------------------
// Comparing two runs
// ---------------------------------------------------------------------------

// Metrics compared head-to-head. `better` says which direction is an improvement
// so deltas can be colored good/bad; `get` pulls the value from a gc summary.
const CMP_METRICS = [
  { label: "Throughput", unit: "%", d: 2, better: "higher", get: (s) => s.throughputPercent },
  { label: "p99 pause", unit: "ms", d: 1, better: "lower", get: (s) => s.p99PauseMs },
  { label: "Max pause", unit: "ms", d: 1, better: "lower", get: (s) => s.maxPauseMs },
  { label: "Avg pause", unit: "ms", d: 2, better: "lower", get: (s) => s.avgPauseMs },
  { label: "Total pause", unit: "ms", d: 0, better: "lower", get: (s) => s.totalPauseMs },
  { label: "Alloc rate", unit: "MB/s", d: 0, better: "lower", get: (s) => s.allocRateMbPerSec },
  { label: "Peak heap", unit: "MB", d: 0, better: "lower", get: (s) => (s.peakHeapKb != null ? s.peakHeapKb / 1024 : null) },
  { label: "GC events", unit: "", d: 0, better: "lower", get: (s) => s.eventCount },
  { label: "Runtime", unit: "s", d: 1, better: "neutral", get: (s) => s.runtimeSec },
];

function deltaStatus(delta, better) {
  if (delta == null || Math.abs(delta) < 1e-9 || better === "neutral") return "neutral";
  const improved = better === "higher" ? delta > 0 : delta < 0;
  return improved ? "good" : "bad";
}

function cmpValueCell(v, unit, d) {
  if (v == null || Number.isNaN(v)) return `<td class="num muted">–</td>`;
  return `<td class="num">${fmt(v, d)}${unit ? `<span class="u">${esc(unit)}</span>` : ""}</td>`;
}

function cmpDeltaCell(a, b, m) {
  if (a == null || b == null || Number.isNaN(a) || Number.isNaN(b)) return `<td class="num muted">–</td>`;
  const delta = b - a;
  const status = deltaStatus(delta, m.better);
  const sign = delta > 0 ? "+" : "";
  const pct = a !== 0 ? ` (${delta > 0 ? "+" : ""}${fmt((delta / Math.abs(a)) * 100, 1)}%)` : "";
  const arrow = delta > 0 ? "▲" : delta < 0 ? "▼" : "→";
  return `<td class="num delta" data-status="${status}"><span class="arw">${arrow}</span>${sign}${fmt(delta, m.d)}${m.unit ? esc(m.unit) : ""}<span class="pctc">${esc(pct)}</span></td>`;
}

// Token-level flag diff: highlight tokens in `cmd` that are absent from `otherSet`.
function cmdTokens(cmd) {
  return String(cmd || "").trim().split(/\s+/).filter(Boolean);
}
function renderCmdDiff(cmd, otherSet, cls) {
  if (!cmd) return `<span class="muted">(not recorded)</span>`;
  return cmdTokens(cmd)
    .map((t) => (otherSet.has(t) ? `<span class="tok">${esc(t)}</span>` : `<span class="tok ${cls}">${esc(t)}</span>`))
    .join(" ");
}

function compareCard(r, tag, tagClass) {
  const cfg = r.gcConfig || {};
  const collector = cfg.youngCollector ? `${cfg.youngCollector} / ${cfg.oldCollector}` : "–";
  return `<div class="cmp-card">
    <span class="cmp-tag ${tagClass}">${esc(tag)}</span>
    <div class="cmp-card-when">${esc(fmtRunTime(r.generatedAt) || r.runId || "")}</div>
    <div class="cmp-card-label">${esc(r.label || "Unlabeled run")}</div>
    <div class="cmp-card-col">${esc(collector)}</div>
  </div>`;
}

function renderCompare(aReport, bReport) {
  const sa = (aReport.gc && aReport.gc.summary) || {};
  const sb = (bReport.gc && bReport.gc.summary) || {};
  const out = [];

  out.push(sectionHeader("Comparison"));
  out.push(`<div class="cmp-head reveal" style="--i:0">
    ${compareCard(aReport, "Baseline", "base")}
    <span class="cmp-vs">vs</span>
    ${compareCard(bReport, "Selected", "sel")}
  </div>`);

  // Headline summary of the two most decisive metrics.
  const tpD = (sb.throughputPercent ?? 0) - (sa.throughputPercent ?? 0);
  const p99D = (sb.p99PauseMs ?? 0) - (sa.p99PauseMs ?? 0);
  const parts = [];
  if (sa.throughputPercent != null && sb.throughputPercent != null) parts.push(`throughput ${tpD >= 0 ? "+" : ""}${fmt(tpD, 2)} pp`);
  if (sa.p99PauseMs != null && sb.p99PauseMs != null) parts.push(`p99 pause ${p99D >= 0 ? "+" : ""}${fmt(p99D, 1)} ms`);
  if (parts.length) out.push(`<p class="cmp-summary reveal" style="--i:1">Selected vs baseline: ${esc(parts.join(", "))}.</p>`);

  // Metric-by-metric table.
  const rows = CMP_METRICS.map((m) => {
    const a = m.get(sa), b = m.get(sb);
    return `<tr>
      <td class="k">${esc(m.label)}</td>
      ${cmpValueCell(a, m.unit, m.d)}
      ${cmpValueCell(b, m.unit, m.d)}
      ${cmpDeltaCell(a, b, m)}
    </tr>`;
  }).join("");
  out.push(`<div class="panels reveal" style="--i:2"><div class="panel wide">
    <table class="cmp-table">
      <thead><tr><th>Metric</th><th class="num">Baseline</th><th class="num">Selected</th><th class="num">Δ</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div></div>`);

  // Command / flag diff.
  const setA = new Set(cmdTokens(aReport.command));
  const setB = new Set(cmdTokens(bReport.command));
  if (aReport.command || bReport.command) {
    out.push(sectionHeader("Command & flags"));
    out.push(`<div class="panels reveal" style="--i:3"><div class="panel wide cmd-diff">
      <div class="cmd-diff-row"><span class="cmp-tag base">Baseline</span><pre class="cmd">${renderCmdDiff(aReport.command, setB, "removed")}</pre></div>
      <div class="cmd-diff-row"><span class="cmp-tag sel">Selected</span><pre class="cmd">${renderCmdDiff(bReport.command, setA, "added")}</pre></div>
      <div class="cmd-diff-legend"><span class="item"><span class="sw removed"></span>only in baseline</span><span class="item"><span class="sw added"></span>only in selected</span></div>
    </div></div>`);
  }

  return out.join("");
}

// Small line+dot chart for a metric's value across an ordered list of runs
// (not a time series — x is run index, each point tooltipped with its run
// label since a sweep is usually too short for readable x-axis tick labels).
function sweepTrendChart(points, { w = 560, h = 220, ylabel = "", yfmt = (v) => fmt(v, 0) } = {}) {
  if (!points.length) return emptyChart(w, h);
  const ys = points.map((p) => p.v);
  const ymax = Math.max(...ys, 1) * 1.08;
  const ymin = Math.min(0, Math.min(...ys));
  const f = frame({ w, h, xmin: 0, xmax: Math.max(points.length - 1, 1), ymin, ymax, xlabel: "Run (see legend above)", ylabel, yfmt });
  const d = points.map((p, i) => `${i ? "L" : "M"}${f.px(p.t).toFixed(1)},${f.py(p.v).toFixed(1)}`).join(" ");
  let dots = "";
  for (const p of points) {
    dots += `<circle class="dot" cx="${f.px(p.t).toFixed(1)}" cy="${f.py(p.v).toFixed(1)}" r="4" fill="var(--accent)"><title>${esc(p.label)}: ${esc(yfmt(p.v))}</title></circle>`;
  }
  return svgWrap(w, h, f.g + `<path d="${d}" fill="none" stroke="var(--accent)" stroke-width="1.6"/>` + dots);
}

// N-way comparison across an ordered list of runs (e.g. a heap-size or
// GC-flag sweep) — unlike renderCompare's baseline/selected delta view,
// this highlights the best value per metric and charts each metric's trend
// across the whole run set, not just a two-point before/after.
function renderSweep(reports) {
  const summaries = reports.map((r) => (r.gc && r.gc.summary) || {});
  const labels = reports.map((r, i) => r.label || `Run ${i + 1}`);
  const out = [];

  out.push(sectionHeader("Sweep", `${reports.length} runs`));

  out.push(`<div class="cmp-head reveal" style="--i:0">` +
    reports.map((r, i) => `<div class="cmp-card">
      <span class="cmp-tag" style="background:${PALETTE[i % PALETTE.length]}22;color:${PALETTE[i % PALETTE.length]}">${i + 1}. ${esc(labels[i])}</span>
      <div class="cmp-card-when">${esc(fmtRunTime(r.generatedAt) || r.runId || "")}</div>
    </div>`).join("") +
    `</div>`);

  const headCells = labels.map((l, i) => `<th class="num" style="color:${PALETTE[i % PALETTE.length]}">${i + 1}</th>`).join("");
  const rows = CMP_METRICS.map((m) => {
    const values = summaries.map((s) => m.get(s));
    const numeric = values.filter((v) => v != null && !Number.isNaN(v));
    let bestVal = null;
    if (numeric.length && m.better !== "neutral") {
      bestVal = m.better === "higher" ? Math.max(...numeric) : Math.min(...numeric);
    }
    const cells = values.map((v) => {
      const isBest = bestVal != null && v === bestVal;
      const cell = cmpValueCell(v, m.unit, m.d);
      return isBest ? cell.replace('<td class="num"', '<td class="num best"') : cell;
    }).join("");
    return `<tr><td class="k">${esc(m.label)}</td>${cells}</tr>`;
  }).join("");
  out.push(`<div class="panels reveal" style="--i:1"><div class="panel wide">
    <table class="cmp-table">
      <thead><tr><th>Metric</th>${headCells}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div></div>`);

  const TREND_LABELS = ["Throughput", "p99 pause", "Max pause", "GC events"];
  const charts = CMP_METRICS.filter((m) => TREND_LABELS.includes(m.label)).map((m) => {
    const points = summaries.map((s, i) => ({ t: i, v: m.get(s), label: labels[i] })).filter((p) => p.v != null && !Number.isNaN(p.v));
    return `<div class="panel"><h3>${esc(m.label)} across runs</h3>${sweepTrendChart(points, { ylabel: m.unit || "", yfmt: (v) => fmt(v, m.d) })}</div>`;
  }).join("");
  out.push(sectionHeader("Trends"));
  out.push(`<div class="panels reveal" style="--i:2">${charts}</div>`);

  return out.join("");
}
