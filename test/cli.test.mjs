import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
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
