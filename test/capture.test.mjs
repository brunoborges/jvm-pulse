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
import { join as pathJoin } from "node:path";

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
