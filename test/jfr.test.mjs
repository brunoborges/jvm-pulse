import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";

let scenario = 0;

async function withJfrTool(output, check) {
  const calls = [];
  const original = childProcess.execFile;
  function fakeExecFile() { throw new Error("expected promisified execFile"); }
  fakeExecFile[promisify.custom] = async (bin, args) => {
    assert.equal(bin, "test-jfr");
    calls.push(args);
    return { stdout: output(args), stderr: "" };
  };
  childProcess.execFile = fakeExecFile;
  syncBuiltinESMExports();
  try {
    const { extractJfr } = await import(`../lib/jfr.mjs?scenario=${++scenario}`);
    await check(extractJfr, calls);
  } finally {
    childProcess.execFile = original;
    syncBuiltinESMExports();
  }
}

function toolOutput(args, { views = true } = {}) {
  if (args[0] === "help") {
    return ` jfr print [--json] <file>\n jfr summary <file>\n${views ? " jfr view <view> <file>\n" : ""}`;
  }
  if (args[0] === "summary") {
    return " jdk.ExecutionSample 10 100\n jdk.ObjectAllocationSample 20 200\n";
  }
  if (args[0] === "print") {
    const event = args[args.indexOf("--events") + 1];
    const values = event === "jdk.CPULoad"
      ? { startTime: "2026-01-01T00:00:01Z", jvmUser: 0.2, jvmSystem: 0.1, machineTotal: 0.4 }
      : event === "jdk.JVMInformation"
        ? { jvmName: "OpenJDK", jvmVersion: "17", jvmArguments: "-Xmx512m", pid: 123 }
        : event === "jdk.ExceptionStatistics"
          ? { throwables: 7 }
          : null;
    return JSON.stringify({ recording: { events: values ? [{ values }] : [] } });
  }
  if (args[0] === "view") {
    if (!views) throw new Error("view must not be invoked on this JDK");
    if (args.includes("allocation-by-class")) {
      return "Allocation Pressure\n---------------- ----\ncom.example.Work 80.0%\n\n";
    }
    if (args.includes("hot-methods")) {
      return "Hot Methods\n---------------- ---- ----\ncom.example.Work.run() 3 30.0%\n\n";
    }
    return "Exception Sites\n---------------- ----\n\n";
  }
  throw new Error(`unexpected command: ${args.join(" ")}`);
}

test("an older JFR tool preserves basic events and explicitly warns about unavailable views", async () => {
  await withJfrTool((args) => toolOutput(args, { views: false }), async (extractJfr, calls) => {
    const result = await extractJfr("test-jfr", "recording.jfr");
    assert.equal(result.available, true);
    assert.equal(result.viewsSupported, false);
    assert.equal(result.cpuLoad.length, 1);
    assert.equal(result.cpuLoad[0].jvmUser, 0.2);
    assert.equal(result.sampleCount, 10);
    assert.equal(result.allocationSampleCount, 20);
    assert.equal(result.exceptions.available, true);
    assert.equal(result.exceptions.total, 7);
    assert.deepEqual(result.exceptions.bySite, []);
    assert.deepEqual(result.topAllocations, []);
    assert.deepEqual(result.hotMethods, []);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /JDK 21\+ required/);
    assert.match(result.warnings[0], /re-ingest the same recording/);
    assert.ok(!calls.some((args) => args[0] === "view"));
  });
});

test("a newer analysis tool extracts views from a recording produced by an older JVM", async () => {
  await withJfrTool(toolOutput, async (extractJfr) => {
    const result = await extractJfr("test-jfr", "recording.jfr");
    assert.equal(result.viewsSupported, true);
    assert.equal(result.jvm.version, "17");
    assert.deepEqual(result.topAllocations, [{ name: "com.example.Work", pressurePct: 80, weightMb: null }]);
    assert.deepEqual(result.hotMethods, [{ name: "com.example.Work.run()", samples: 3, pct: 30 }]);
    assert.deepEqual(result.warnings, []);
  });
});

test("a failed view warns without discarding other JFR data", async () => {
  await withJfrTool((args) => {
    if (args.includes("allocation-by-class")) {
      throw Object.assign(new Error("view failed"), { stderr: "Could not read allocation view\n" });
    }
    return toolOutput(args);
  }, async (extractJfr) => {
    const result = await extractJfr("test-jfr", "recording.jfr");
    assert.equal(result.available, true);
    assert.equal(result.hotMethods.length, 1);
    assert.deepEqual(result.warnings, ["Top allocations: Could not read allocation view"]);
  });
});

test("failed event extraction and summary commands are not silently treated as zero activity", async () => {
  await withJfrTool((args) => {
    if (args[0] === "summary" || args.includes("jdk.CPULoad")) throw new Error("recording is truncated");
    return toolOutput(args);
  }, async (extractJfr) => {
    const result = await extractJfr("test-jfr", "recording.jfr");
    assert.ok(result.warnings.includes("CPU load: recording is truncated"));
    assert.ok(result.warnings.includes("JFR event counts: recording is truncated"));
    assert.equal(result.hotMethods.length, 1);
  });
});

test("an unavailable JFR executable reports an actionable error instead of an empty successful analysis", async () => {
  await withJfrTool(() => { throw new Error("spawn test-jfr ENOENT"); }, async (extractJfr, calls) => {
    const result = await extractJfr("test-jfr", "recording.jfr");
    assert.equal(result.available, false);
    assert.match(result.error, /Could not inspect the JFR tool/);
    assert.match(result.error, /JAVA_HOME and PATH/);
    assert.equal(calls.length, 1);
  });
});
