// Capture GC/JFR telemetry from a JVM via two primitives: inject-launch (set
// JDK_JAVA_OPTIONS and spawn a new process) and attach (jcmd against a JVM
// that's already running, locally or inside a container). Both are agent-
// and project-agnostic — the caller decides which mode and what command/pid.
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import { join, resolve, basename } from "node:path";

const execFileAsync = promisify(execFile);

/**
 * Build the JDK_JAVA_OPTIONS value for GC-log + JFR capture. Filenames use
 * %p (JVM launcher-substituted PID) so a wrapper command's own bootstrap JVM
 * picking up the same env var (e.g. Maven's launcher when running
 * `mvn spring-boot:run`) never collides with the target process's files —
 * each java process that sees these options gets its own, uniquely-named
 * output, even though only one of them is the process we actually care about.
 *
 * `outDir` must be a relative path (or otherwise colon-free). -Xlog's file
 * output splits on unescaped ':' — an absolute Windows path's drive-letter
 * colon (e.g. C:\work\out) would collide with that. bin/pulse.mjs always
 * passes a relative runs/<ts> dir, which avoids this; any other caller of
 * this function must do the same.
 */
export function buildJavaOptions({ outDir, jfrMaxMb = 100 }) {
  const gcLogPattern = join(outDir, "gc-%p.log");
  const jfrPattern = join(outDir, "dump-%p.jfr");
  const gcFlag = `-Xlog:gc*:file=${gcLogPattern}:time,uptime,level,tags`;
  const jfrFlag = `-XX:StartFlightRecording=name=pulse,maxsize=${jfrMaxMb}M,filename=${jfrPattern},settings=profile,dumponexit=true`;
  return { options: `${gcFlag} ${jfrFlag}`, gcLogPattern, jfrPattern };
}

/** Resolve a %p-templated filename pattern to the actual file a JVM with the
 *  given pid wrote. (%t isn't resolved here — callers needing a programmatic
 *  path must not rely on %t, only %p.) */
export function resolvePidFilename(pattern, pid) {
  return pattern.replace(/%p/g, String(pid));
}

/**
 * inject-launch: spawn `command` with JDK_JAVA_OPTIONS set so it (and any
 * java launcher in its process tree) picks up GC-log/JFR flags. Resolves
 * once the process exits, or after `durationMs` if given (for a long-running
 * server that never exits on its own) — whichever comes first.
 */
export async function injectLaunch({ command, args = [], outDir, jfrMaxMb, durationMs, cwd }) {
  // outDir must stay relative (see buildJavaOptions' -Xlog colon constraint),
  // and the spawned child resolves that relative path against ITS OWN cwd
  // (`cwd`, defaulting to this process's cwd like spawn() itself does) — not
  // against this process's cwd. mkdir must create the directory in the same
  // place. Just as important: the gcLogPath/jfrPath THIS FUNCTION RETURNS
  // are read back by the CALLER (pulse's own process, via
  // analyzeArtifacts()/existsSync()), which resolves relative paths against
  // ITS OWN cwd — so the returned paths must be absolute, anchored at the
  // same baseDir the JVM actually wrote into, not left relative to outDir.
  const baseDir = resolve(cwd ?? process.cwd(), outDir);
  await mkdir(baseDir, { recursive: true });
  const { options, gcLogPattern, jfrPattern } = buildJavaOptions({ outDir, jfrMaxMb });
  // Preserve any caller-provided JDK_JAVA_OPTIONS rather than clobbering it —
  // workloads commonly rely on that variable for required -D/-XX settings, and
  // replacing it would change or break the very process we're measuring. Ours
  // go last so a capture flag wins if it ever conflicts.
  const priorJavaOptions = process.env.JDK_JAVA_OPTIONS;
  const mergedJavaOptions = priorJavaOptions ? `${priorJavaOptions} ${options}` : options;
  // Same filenames buildJavaOptions just put in the JVM flags (relative,
  // required there — see its own doc comment), re-anchored at baseDir
  // instead of retyping "gc-%p.log"/"dump-%p.jfr" as a second literal.
  const absGcLogPattern = join(baseDir, basename(gcLogPattern));
  const absJfrPattern = join(baseDir, basename(jfrPattern));

  // Named to avoid shadowing node:path's `resolve`, imported above and used
  // just now for `baseDir` — a same-named Promise-executor parameter here
  // previously shadowed it silently within this whole callback.
  return new Promise((resolvePromise, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: { ...process.env, JDK_JAVA_OPTIONS: mergedJavaOptions },
        stdio: "inherit",
      });
    } catch (e) {
      reject(e);
      return;
    }

    let settled = false;
    let timer = null;
    let killTimer = null;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (err) return reject(err);
      resolvePromise({
        pid: child.pid,
        gcLogPath: resolvePidFilename(absGcLogPattern, child.pid),
        jfrPath: resolvePidFilename(absJfrPattern, child.pid),
        outDir: baseDir,
      });
    };

    child.on("error", finish);
    child.on("exit", () => finish(null));

    if (durationMs) {
      timer = setTimeout(() => {
        // `pulse run` launched this process specifically for this capture
        // window (profiling an already-running long-lived service is what
        // `pulse attach` is for, not `run`) — so once the window elapses,
        // stop+finalize the JFR recording (it was started with name=pulse
        // so it's addressable) and SIGTERM the process so it runs its
        // shutdown hooks: flush the GC log and dump the JFR (dumponexit=true).
        // Resolve via the child's own `exit` handler AFTER that completes —
        // resolving here would race the shutdown-time writes, and on Windows
        // scratch-dir deletion could then fail on files the JVM still holds
        // open. Force-kill only if it ignores SIGTERM, so the CLI can never
        // hang waiting on a process that refuses to exit.
        execFileAsync("jcmd", [String(child.pid), "JFR.stop", "name=pulse"])
          .catch(() => {})
          .finally(() => {
            child.kill("SIGTERM");
            killTimer = setTimeout(() => child.kill("SIGKILL"), 15000);
          });
      }, durationMs);
    }
  });
}

/**
 * attach: start GC-log + profiling JFR on a JVM that's already running,
 * without restarting it. `transport` selects where jcmd runs — {type:'local'}
 * (default) or {type:'docker', container} (added in a later task).
 */
export async function attach({ pid, transport = { type: "local" }, outDir, jfrMaxMb = 100, durationMs }) {
  // Validate pure arguments before any I/O — a forgotten --duration on a
  // docker attach would otherwise burn a preflight + pid-discovery round
  // trip (or an mkdir) only to fail on something checkable instantly, and a
  // docker connectivity error would mask the real problem.
  if (!durationMs) {
    throw new Error("attach requires --duration (e.g. 30s) — without it the JFR/GC-log window closes before any data is captured");
  }

  await mkdir(outDir, { recursive: true });
  // jcmd's diagnostic commands (VM.log, JFR.stop) execute INSIDE the target
  // JVM process, so a relative output/filename argument resolves against the
  // target's own cwd, not this process's — silently wrong whenever attach is
  // run from a different directory than the target (the common case for any
  // already-running service). Resolve to an absolute path up front so it's
  // unambiguous regardless of whose cwd is asking. Safe here — unlike
  // buildJavaOptions' single colon-delimited -Xlog flag string, jcmd takes
  // output=/filename= as separate arguments, so an absolute Windows path's
  // drive-letter colon doesn't collide with anything.
  const absOutDir = resolve(outDir);

  if (transport.type === "docker") {
    // A host-supplied --pid would be in the wrong PID namespace (the exact
    // bug this auto-discovery exists to prevent) — never accept one here,
    // always discover the in-container pid ourselves.
    if (pid != null) {
      throw new Error("--pid is not supported with --docker — the in-container PID is auto-discovered (a host-side PID would be in the wrong namespace)");
    }
    // Independent checks (neither's result feeds the other) — run them
    // concurrently rather than paying two sequential docker-exec round trips.
    const [, discoveredPid] = await Promise.all([preflightDockerJcmd(transport.container), discoverContainerJavaPid(transport.container)]);
    pid = discoveredPid;
  }
  if (pid == null) throw new Error("attach requires --pid (or --docker <container> to auto-discover it)");

  // Where the files end up on THIS machine either way — computed once so the
  // docker copy-back below and the non-docker jcmd target can't drift apart.
  const localGcLog = join(absOutDir, "gc-attach.log");
  const localJfr = join(absOutDir, "dump-attach.jfr");
  // In-container paths (docker) vs. plain local paths.
  const remoteGcLog = transport.type === "docker" ? "/tmp/pulse-gc.log" : localGcLog;
  const remoteJfr = transport.type === "docker" ? "/tmp/pulse-dump.jfr" : localJfr;
  const run = (args) => runJcmd(transport, [String(pid), ...args]);

  await run(["VM.log", `output=${remoteGcLog}`, "what=gc*", "decorators=time,uptime,level,tags"]);
  try {
    await run(["JFR.start", "name=pulse", "settings=profile", `maxsize=${jfrMaxMb}M`]);
    await new Promise((r) => setTimeout(r, durationMs));
    await run(["JFR.stop", "name=pulse", `filename=${remoteJfr}`]);
  } finally {
    // The VM.log call above reconfigured logging inside the TARGET JVM, and
    // that configuration outlives this process: left alone, the attached JVM
    // keeps appending to remoteGcLog for the rest of its life (and holds the
    // file handle open, so on Windows the caller can't even delete the
    // capture dir). Turn off exactly the output we added — all=off empties
    // its tag selections, which makes the JVM drop the output and close the
    // file. Not `VM.log disable`: that would also wipe any -Xlog config the
    // JVM's owner had set up before we attached. Runs in a finally so a JFR
    // failure mid-capture can't leak the logging, with its own error
    // swallowed so cleanup never masks the capture error being thrown.
    await run(["VM.log", `output=${remoteGcLog}`, "what=all=off"]).catch(() => {});
  }

  if (transport.type === "docker") {
    await execFileAsync("docker", ["cp", `${transport.container}:${remoteGcLog}`, localGcLog]);
    await execFileAsync("docker", ["cp", `${transport.container}:${remoteJfr}`, localJfr]);
    return { pid, gcLogPath: localGcLog, jfrPath: localJfr, outDir: absOutDir };
  }
  return { pid, gcLogPath: remoteGcLog, jfrPath: remoteJfr, outDir: absOutDir };
}

async function preflightDockerJcmd(container) {
  try {
    // `command -v` is a POSIX shell builtin — unlike `which`, it needs no
    // external binary, so it works on minimal images that omit `which`
    // (confirmed against a glibc Corretto image that has jcmd but not which).
    await execFileAsync("docker", ["exec", container, "sh", "-c", "command -v jcmd"]);
  } catch {
    throw new Error(
      `no jcmd in container "${container}" — jcmd ships with a JDK, not a JRE. ` +
      `Rebuild on a JDK base image, or capture via "pulse run" instead.`
    );
  }
}

async function discoverContainerJavaPid(container) {
  try {
    // `docker exec ... jps` self-lists: jps runs as its own short-lived JVM
    // inside the container's PID namespace, so it always sees itself
    // alongside the real target. `-q` gives no way to tell the two apart
    // (bare pids), so it always looks like "multiple java processes" even
    // when there's genuinely only one. `-lv` adds the main-class column,
    // which lets us filter out jps's own self-listing (main class
    // `sun.tools.jps.Jps`) — do not "simplify" this back to `-q`.
    const { stdout } = await execFileAsync("docker", ["exec", container, "jps", "-lv"]);
    const pids = stdout
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter(([, mainClass]) => mainClass && !mainClass.includes("sun.tools.jps.Jps"))
      .map(([pid]) => pid)
      .filter(Boolean);
    if (pids.length === 1) return pids[0];
    if (pids.length > 1) {
      throw new Error(`multiple java processes in container "${container}" (pids: ${pids.join(", ")}) — pulse auto-attach only supports a single-JVM container (a host-side --pid would be in the wrong namespace, so it can't disambiguate). Run one JVM per container, or use "pulse run" to launch+capture a specific command.`);
    }
  } catch (e) {
    if (String(e.message).includes("multiple java processes")) throw e;
  }
  // No jps, or it found nothing usable — fall back to PID 1, the common case
  // for a single-process container entrypoint. NOT universal, though: whether
  // java actually ends up as PID 1 depends on the entrypoint's shell — an
  // Alpine/busybox `sh -c /entrypoint.sh` collapses into the java process's
  // own `exec java …` (java = PID 1), but the same entrypoint script under
  // Ubuntu/dash does not (java runs as a child pid instead, e.g. rating-engine's
  // jib-built image on eclipse-temurin:*-jammy). This fallback only matters
  // when jps itself is unusable; the primary path above is unaffected either way.
  return "1";
}

/**
 * jcmd relays diagnostic-command failures as plain text on ITS OWN stdout and
 * still exits 0 — the exit code only reflects whether the command reached the
 * target JVM, not whether it worked. Seen live against a containerized JDK
 * 17.0.19: `JFR.stop name=pulse filename=…` printed "Dump failed. Could not
 * copy recording data. Unexpected error during I/O operation", exited 0, and
 * left a 0-byte .jfr that sailed through exit-code-only checking into empty
 * analysis panels. So scan the text for the dump-failure signature too.
 * Root cause that time: the JVM's JFR repository directory was empty/unusable
 * — hence the -XX:FlightRecorderOptions=repository hint in the message.
 */
export function checkJcmdDumpOutput(stdout, args = []) {
  if (/^Dump failed/m.test(stdout)) {
    throw new Error(
      `jcmd ${args.join(" ")} reported a failure (despite exiting 0):\n${stdout.trim()}\n` +
      `No usable recording was written — commonly the target JVM's JFR repository ` +
      `directory is empty or unwritable (check its -XX:FlightRecorderOptions=repository setting).`
    );
  }
  return stdout;
}

async function runJcmd(transport, args) {
  if (transport.type === "docker") {
    const { stdout } = await execFileAsync("docker", ["exec", transport.container, "jcmd", ...args]);
    return checkJcmdDumpOutput(stdout, args);
  }
  const { stdout } = await execFileAsync("jcmd", args);
  return checkJcmdDumpOutput(stdout, args);
}
