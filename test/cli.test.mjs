import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
// ponytail: fileURLToPath (not .pathname) — .pathname keeps the leading "/"
// on Windows ("/C:/...") which node's CLI script resolution mangles into a
// double-drive-letter path (MODULE_NOT_FOUND). Same fix bin/pulse.mjs uses.
const CLI = fileURLToPath(new URL("../bin/pulse.mjs", import.meta.url));

test("pulse with no subcommand prints usage and exits 1", async () => {
  await assert.rejects(execFileAsync(process.execPath, [CLI]), (err) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /usage: pulse/); // matches fail()'s lowercase "pulse: usage: pulse ..." output
    return true;
  });
});

test("pulse ingest requires --gc-log", async () => {
  await assert.rejects(execFileAsync(process.execPath, [CLI, "ingest"]), (err) => {
    assert.match(err.stderr, /--gc-log/);
    return true;
  });
});

test("pulse ingest fails clearly when the gc-log path doesn't exist", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [CLI, "ingest", "--gc-log", "/does/not/exist.log"]),
    (err) => {
      assert.match(err.stderr, /GC log not found/);
      return true;
    }
  );
});

test("pulse sweep requires at least 2 runId arguments", async () => {
  await assert.rejects(execFileAsync(process.execPath, [CLI, "sweep", "only-one-run"]), (err) => {
    assert.match(err.stderr, /sweep requires 2\+/);
    return true;
  });
});

test("pulse sweep fails clearly when a run doesn't exist", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [CLI, "sweep", "does-not-exist-1", "does-not-exist-2"]),
    (err) => {
      assert.match(err.stderr, /run\(s\) not found: does-not-exist-1, does-not-exist-2/);
      return true;
    }
  );
});

test("pulse run always cleans up its scratch runs/ directory, even when analysis fails", async () => {
  // Regression test: injectLaunch's scratch dir is disposable once
  // analyzeArtifacts copies what it needs into its own managed run store —
  // it must not survive the command, on the success path OR the failure
  // path (a try/finally, not an end-of-happy-path step).
  const cwd = await mkdtemp(join(tmpdir(), "pulse-cli-cwd-"));
  try {
    await assert.rejects(
      // `node -e "process.exit(0)"` isn't a java launcher, so it produces no
      // real gc-log — analyzeArtifacts() fails with "GC log not found",
      // which is the point: cleanup must still happen on this failure path.
      execFileAsync(process.execPath, [CLI, "run", "--", process.execPath, "-e", "process.exit(0)"], { cwd }),
      (err) => {
        assert.match(err.stderr, /GC log not found/);
        return true;
      }
    );
    const entries = await readdir(cwd).catch(() => []);
    assert.ok(!entries.includes("runs"), `expected no leftover runs/ dir in ${cwd}, found: ${entries.join(", ")}`);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
