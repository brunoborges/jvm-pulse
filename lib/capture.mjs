// Capture GC/JFR telemetry from a JVM via two primitives: inject-launch (set
// JDK_JAVA_OPTIONS and spawn a new process) and attach (jcmd against a JVM
// that's already running, locally or inside a container). Both are agent-
// and project-agnostic — the caller decides which mode and what command/pid.
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

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
  await mkdir(outDir, { recursive: true });
  const { options, gcLogPattern, jfrPattern } = buildJavaOptions({ outDir, jfrMaxMb });

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: { ...process.env, JDK_JAVA_OPTIONS: options },
        stdio: "inherit",
      });
    } catch (e) {
      reject(e);
      return;
    }

    let settled = false;
    let timer = null;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) return reject(err);
      resolve({
        pid: child.pid,
        gcLogPath: resolvePidFilename(gcLogPattern, child.pid),
        jfrPath: resolvePidFilename(jfrPattern, child.pid),
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
        // so it's addressable) and terminate the process, rather than
        // leaving an un-awaited child handle that would keep the CLI
        // process alive indefinitely.
        execFileAsync("jcmd", [String(child.pid), "JFR.stop", "name=pulse"])
          .catch(() => {})
          .finally(() => {
            child.kill("SIGTERM");
            finish(null);
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
  await mkdir(outDir, { recursive: true });
  if (pid == null) throw new Error("attach requires --pid (or --docker <container> to auto-discover it)");

  const gcLog = join(outDir, "gc-attach.log");
  const jfrFile = join(outDir, "dump-attach.jfr");
  const run = (args) => runJcmd(transport, [String(pid), ...args]);

  await run(["VM.log", `output=${gcLog}`, "what=gc*", "decorators=time,uptime,level,tags"]);
  await run(["JFR.start", "name=pulse", "settings=profile", `maxsize=${jfrMaxMb}M`]);
  if (durationMs) await new Promise((r) => setTimeout(r, durationMs));
  await run(["JFR.stop", "name=pulse", `filename=${jfrFile}`]);

  return { pid, gcLogPath: gcLog, jfrPath: jfrFile };
}

async function runJcmd(transport, args) {
  if (transport.type === "docker") {
    const { stdout } = await execFileAsync("docker", ["exec", transport.container, "jcmd", ...args]);
    return stdout;
  }
  const { stdout } = await execFileAsync("jcmd", args);
  return stdout;
}
