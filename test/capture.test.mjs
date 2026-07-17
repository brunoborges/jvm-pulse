import { test } from "node:test";
import assert from "node:assert/strict";
import { buildJavaOptions, resolvePidFilename } from "../lib/capture.mjs";

test("buildJavaOptions includes %p-templated GC log and JFR flags", () => {
  const { options, gcLogPattern, jfrPattern } = buildJavaOptions({ outDir: "out", jfrMaxMb: 50 });
  assert.match(options, /-Xlog:gc\*:file=.*gc-%p\.log:time,uptime,level,tags/);
  assert.match(options, /-XX:StartFlightRecording=name=pulse,maxsize=50M,filename=.*dump-%p\.jfr,settings=profile,dumponexit=true/);
  assert.match(gcLogPattern, /gc-%p\.log$/);
  assert.match(jfrPattern, /dump-%p\.jfr$/);
});

test("buildJavaOptions defaults jfrMaxMb to 100", () => {
  const { options } = buildJavaOptions({ outDir: "out" });
  assert.match(options, /maxsize=100M/);
});

test("resolvePidFilename substitutes %p with the real pid", () => {
  assert.equal(resolvePidFilename("out/gc-%p.log", 12345), "out/gc-12345.log");
});

import { injectLaunch } from "../lib/capture.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as pathJoin, isAbsolute } from "node:path";

test("injectLaunch resolves with pid and gc-log/jfr paths once the process exits", async () => {
  const outDir = await mkdtemp(pathJoin(tmpdir(), "pulse-test-"));
  try {
    // `node -e "process.exit(0)"` isn't a java launcher, so it won't actually
    // produce gc.log/jfr — this test only proves the plumbing (env var set,
    // process spawned, promise resolves with pid-substituted paths), not real
    // JVM capture (that's proven end-to-end against rating-engine in a later task).
    const result = await injectLaunch({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      outDir,
    });
    assert.ok(result.pid > 0);
    assert.ok(result.gcLogPath.includes(String(result.pid)));
    assert.ok(result.jfrPath.includes(String(result.pid)));
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test("injectLaunch creates outDir relative to --cwd, not this process's own cwd", async () => {
  // Regression test for a real bug: mkdir used to run against this process's
  // cwd unconditionally, ignoring `cwd` — so a --cwd different from pulse's
  // own invocation directory left the spawned JVM's -Xlog/JFR flags pointing
  // at a directory that was never created.
  const targetCwd = await mkdtemp(pathJoin(tmpdir(), "pulse-target-cwd-"));
  const outDir = "runs/relative-out";
  try {
    await injectLaunch({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      outDir,
      cwd: targetCwd,
    });
    assert.ok(existsSync(pathJoin(targetCwd, outDir)), `expected ${outDir} to exist under ${targetCwd}, not this process's cwd`);
  } finally {
    await rm(pathJoin(targetCwd, "runs"), { recursive: true, force: true });
    await rm(targetCwd, { recursive: true, force: true });
  }
});

test("injectLaunch returns absolute gc-log/jfr/outDir paths anchored under --cwd, not this process's cwd", async () => {
  // Regression test: mkdir/JVM-flags being --cwd-aware (the test above)
  // isn't enough on its own — the paths THIS FUNCTION RETURNS are read back
  // by the caller (pulse's own process), which resolves a relative path
  // against ITS OWN cwd. Under a differing --cwd those used to point at a
  // location that was never created, even though the JVM itself wrote the
  // real files correctly under --cwd.
  const targetCwd = await mkdtemp(pathJoin(tmpdir(), "pulse-target-cwd-"));
  const outDir = "runs/relative-out-abs";
  try {
    const result = await injectLaunch({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      outDir,
      cwd: targetCwd,
    });
    assert.ok(isAbsolute(result.gcLogPath), `expected an absolute gc log path, got ${result.gcLogPath}`);
    assert.ok(isAbsolute(result.jfrPath), `expected an absolute jfr path, got ${result.jfrPath}`);
    assert.ok(isAbsolute(result.outDir), `expected an absolute outDir, got ${result.outDir}`);
    assert.ok(result.gcLogPath.startsWith(targetCwd), `expected gcLogPath anchored under ${targetCwd}, got ${result.gcLogPath}`);
    assert.ok(result.outDir.startsWith(targetCwd), `expected outDir anchored under ${targetCwd}, got ${result.outDir}`);
  } finally {
    await rm(pathJoin(targetCwd, "runs"), { recursive: true, force: true });
    await rm(targetCwd, { recursive: true, force: true });
  }
});

test("injectLaunch sets JDK_JAVA_OPTIONS on the child process's environment", async () => {
  // injectLaunch spawns with stdio:"inherit" (so a profiled app's own logs
  // stay visible to whoever runs `pulse run`) — that means the child's
  // stdout can't be captured from the test. Have the child write what it
  // saw to a file instead, so the assertion observes something real rather
  // than just re-checking injectLaunch resolved (which the first test
  // already covers).
  const outDir = await mkdtemp(pathJoin(tmpdir(), "pulse-test-"));
  const marker = pathJoin(outDir, "env-seen.txt");
  try {
    await injectLaunch({
      command: process.execPath,
      args: ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, process.env.JDK_JAVA_OPTIONS || "")`],
      outDir,
    });
    const { readFileSync } = await import("node:fs");
    const seen = readFileSync(marker, "utf8");
    assert.match(seen, /-Xlog:gc\*/);
    assert.match(seen, /-XX:StartFlightRecording/);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

import { attach } from "../lib/capture.mjs";
import { spawn as spawnProc, execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const execFileAsync = promisify(execFile);

async function toolAvailable(tool, args) {
  try {
    await execFileAsync(tool, args);
    return true;
  } catch (e) {
    return e.code !== "ENOENT"; // exists but exited non-zero still counts as available
  }
}

test("attach (local) issues VM.log, JFR.start, and JFR.stop against a real running JVM", async (t) => {
  if (!(await toolAvailable("javac", ["-version"])) ||
      !(await toolAvailable("java", ["-version"])) ||
      !(await toolAvailable("jcmd", ["-l"]))) {
    t.skip("javac/java/jcmd not available in this environment");
    return;
  }
  const outDir = await mkdtemp(pathJoin(tmpdir(), "pulse-test-"));
  const srcDir = await mkdtemp(pathJoin(tmpdir(), "pulse-sleeper-"));
  const src = pathJoin(srcDir, "Sleeper.java");
  await writeFile(
    src,
    "public class Sleeper { public static void main(String[] a) throws Exception { Thread.sleep(60000); } }"
  );
  await new Promise((resolve, reject) => {
    const c = spawnProc("javac", [src], { stdio: "inherit" });
    c.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("javac failed"))));
  });
  const sleeper = spawnProc("java", ["-cp", srcDir, "Sleeper"], { stdio: "ignore" });
  try {
    // Poll for jcmd to actually see the pid instead of a fixed sleep — JVM
    // cold-start time varies, especially under CI load.
    for (let i = 0; i < 20; i++) {
      const { stdout } = await execFileAsync("jcmd", ["-l"]).catch(() => ({ stdout: "" }));
      if (stdout.includes(String(sleeper.pid))) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const result = await attach({ pid: sleeper.pid, outDir, durationMs: 1000 });
    assert.equal(result.pid, sleeper.pid);
    // Regression: jcmd resolves relative output=/filename= paths against the
    // TARGET process's cwd, not pulse's — attach() must hand it absolute
    // paths so the file lands where pulse actually looks for it.
    assert.ok(isAbsolute(result.gcLogPath), `expected an absolute gc log path, got ${result.gcLogPath}`);
    assert.ok(isAbsolute(result.jfrPath), `expected an absolute jfr path, got ${result.jfrPath}`);
    assert.ok(existsSync(result.gcLogPath), `expected gc log at ${result.gcLogPath}`);
    assert.ok(existsSync(result.jfrPath), `expected jfr file at ${result.jfrPath}`);
  } finally {
    sleeper.kill();
    // On Windows the killed JVM doesn't release its open gc-attach.log
    // handle instantaneously, so an immediate rm can EBUSY — retry with
    // backoff (fs.rm's built-in support for exactly this) rather than
    // hand-rolling a wait-for-exit.
    await rm(outDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await rm(srcDir, { recursive: true, force: true });
  }
});

test("docker attach auto-discovers the in-container pid when --pid is omitted", async (t) => {
  try {
    await execFileAsync("docker", ["--version"]);
  } catch {
    t.skip("docker not available in this environment");
    return;
  }
  const outDir = await mkdtemp(pathJoin(tmpdir(), "pulse-test-"));
  let container;
  try {
    // Auto-discovery needs a real java process in the container to find —
    // `jps -q` (or the PID-1 fallback) has nothing to discover against a
    // bare `sleep`. Compile and run a trivial sleeper as the container's
    // entrypoint (exec'd, so it's PID 1, matching a real single-process
    // container like rating-engine's own jib-built image).
    const { stdout } = await execFileAsync("docker", [
      "run", "-d", "--rm", "eclipse-temurin:21-jdk",
      "sh", "-c",
      "echo 'public class Sleeper { public static void main(String[] a) throws Exception { Thread.sleep(300000); } }' > /tmp/Sleeper.java " +
        "&& javac /tmp/Sleeper.java -d /tmp && exec java -cp /tmp Sleeper",
    ]);
    container = stdout.trim();
    await new Promise((r) => setTimeout(r, 3000)); // let javac/java finish starting inside the container
    const result = await attach({
      transport: { type: "docker", container },
      outDir,
      durationMs: 500,
    });
    assert.ok(result.pid);
  } finally {
    if (container) await execFileAsync("docker", ["rm", "-f", container]).catch(() => {});
    await rm(outDir, { recursive: true, force: true });
  }
});

test("docker attach fails with an actionable message when the container has no jcmd", async (t) => {
  try {
    await execFileAsync("docker", ["--version"]);
  } catch {
    t.skip("docker not available in this environment");
    return;
  }
  const outDir = await mkdtemp(pathJoin(tmpdir(), "pulse-test-"));
  let container;
  try {
    const { stdout } = await execFileAsync("docker", [
      "run", "-d", "--rm", "eclipse-temurin:21-jre",
      "sh", "-c", "sleep 300",
    ]);
    container = stdout.trim();
    await assert.rejects(
      attach({ transport: { type: "docker", container }, outDir, durationMs: 1000 }),
      /no jcmd/i
    );
  } finally {
    if (container) await execFileAsync("docker", ["rm", "-f", container]).catch(() => {});
    await rm(outDir, { recursive: true, force: true });
  }
});

test("attach rejects an explicit --pid when --docker is also given", async () => {
  const outDir = await mkdtemp(pathJoin(tmpdir(), "pulse-test-"));
  try {
    await assert.rejects(
      attach({ pid: "12345", transport: { type: "docker", container: "whatever" }, outDir, durationMs: 1000 }),
      /--pid is not supported with --docker/
    );
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

import { checkJcmdDumpOutput } from "../lib/capture.mjs";

test("checkJcmdDumpOutput rejects jcmd 'Dump failed' text even though jcmd exits 0", () => {
  // Real-world repro (containerized JDK 17.0.19): `jcmd <pid> JFR.stop
  // name=pulse filename=...` printed this to stdout and EXITED 0 — the JVM's
  // JFR repository was empty, so nothing was dumped and a 0-byte .jfr was
  // left behind. Exit-code checking alone treats that as success.
  const out = "4242:\nDump failed. Could not copy recording data. Unexpected error during I/O operation\n";
  assert.throws(
    () => checkJcmdDumpOutput(out, ["4242", "JFR.stop", "name=pulse", "filename=/tmp/pulse-dump.jfr"]),
    /Dump failed[\s\S]*FlightRecorderOptions/
  );
});

test("checkJcmdDumpOutput passes normal jcmd output through unchanged", () => {
  const out = "4242:\nStopped recording \"pulse\". The result was written to:\n/tmp/pulse-dump.jfr\n";
  assert.equal(checkJcmdDumpOutput(out, ["4242", "JFR.stop", "name=pulse"]), out);
});

test("attach without --duration fails loudly instead of silently capturing an empty window", async () => {
  const outDir = await mkdtemp(pathJoin(tmpdir(), "pulse-test-"));
  try {
    await assert.rejects(
      attach({ pid: 99999, outDir }),
      /requires --duration/
    );
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
