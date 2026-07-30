#!/usr/bin/env node
// CLI entry point: wires the capture primitives (lib/capture.mjs) and the
// static renderer (lib/report-static.mjs) around the existing, untouched
// analysis engine (lib/pipeline.mjs). Agent-agnostic — no Copilot SDK here.
import { parseArgs } from "node:util";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { copyFile, mkdir, rm, rmdir } from "node:fs/promises";
import { analyzeArtifacts, loadRun, loadLatest, configureWorkspace } from "../lib/pipeline.mjs";
import { injectLaunch, attach } from "../lib/capture.mjs";
import { writeStaticReport, writeStaticCompare, writeStaticSweep } from "../lib/report-static.mjs";
import { buildAnalysisPrompt } from "../lib/prompt.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

function fail(msg) {
  console.error(`pulse: ${msg}`);
  process.exit(1);
}

function parseDuration(s) {
  const m = /^(\d+)(ms|s|m)?$/.exec(String(s).trim());
  if (!m) fail(`invalid --duration "${s}" — use e.g. 30s, 500ms, 2m`);
  const n = Number(m[1]);
  return m[2] === "ms" ? n : m[2] === "m" ? n * 60_000 : n * 1000;
}

/** A fresh scratch directory for a capture's raw gc-log/JFR output. */
function newCaptureDir() {
  return join("runs", String(Date.now()));
}

/** The --jfr-max-mb/--duration options shared by `run` and `attach`. */
function captureFlags(values) {
  return {
    jfrMaxMb: values["jfr-max-mb"] ? Number(values["jfr-max-mb"]) : undefined,
    durationMs: values.duration ? parseDuration(values.duration) : undefined,
  };
}

async function cmdIngest(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "gc-log": { type: "string" },
      jfr: { type: "string" },
      label: { type: "string" },
      command: { type: "string" },
      baseline: { type: "string" },
      out: { type: "string" },
    },
  });
  if (!values["gc-log"]) fail("ingest requires --gc-log <path>");
  const report = await analyzeArtifacts({
    gcLogPath: values["gc-log"],
    jfrPath: values.jfr,
    label: values.label,
    command: values.command,
  });

  let htmlPath;
  if (values.baseline) {
    const baseline = await loadRun(values.baseline);
    if (!baseline) fail(`baseline run not found: ${values.baseline}`);
    htmlPath = await writeStaticCompare(baseline, report);
  } else {
    htmlPath = await writeStaticReport(report);
  }

  // --out copies the rendered HTML alongside whatever pipeline.mjs's own
  // (untouched, fixed) storage location already wrote it to — it's an
  // additional destination, not a redirect of the analysis engine's
  // internal report.json storage.
  if (values.out) {
    await mkdir(values.out, { recursive: true });
    const dest = join(values.out, basename(htmlPath));
    await copyFile(htmlPath, dest);
    htmlPath = dest;
  }

  console.log(`Report: ${htmlPath}`);
}

/** Analyze the just-captured artifacts, write report.html, print it — then
 *  remove `outDir`, the scratch directory injectLaunch/attach wrote the raw
 *  gc-log/JFR into. analyzeArtifacts() already copied what it needs into its
 *  own managed run directory, so outDir is disposable afterward; leaving it
 *  behind orphaned an untracked runs/<timestamp>/ directory in the user's
 *  cwd on every single `pulse run`/`pulse attach` invocation. */
async function captureAndReport(outDir, { gcLogPath, jfrPath, label, command }) {
  try {
    const report = await analyzeArtifacts({ gcLogPath, jfrPath, label, command });
    const htmlPath = await writeStaticReport(report);
    console.log(`Report: ${htmlPath}`);
  } finally {
    await rm(outDir, { recursive: true, force: true });
    // outDir is always "runs/<timestamp>" — remove the now-empty "runs"
    // parent too, rather than leaving a permanent empty directory behind.
    // Fails harmlessly (caught) if it's not empty or already gone.
    await rmdir(dirname(outDir)).catch(() => {});
  }
}

async function cmdRun(argv) {
  const dashIdx = argv.indexOf("--");
  if (dashIdx === -1) fail('run requires "-- <command> [args...]"');
  const { values } = parseArgs({
    args: argv.slice(0, dashIdx),
    options: {
      duration: { type: "string" },
      "jfr-max-mb": { type: "string" },
      label: { type: "string" },
      cwd: { type: "string" },
    },
  });
  const [command, ...cmdArgs] = argv.slice(dashIdx + 1);
  if (!command) fail('run requires a command after "--"');

  // injectLaunch reports back the absolute directory it actually used (it
  // may differ from this process's own cwd when --cwd is given) — clean up
  // that one, not a recomputed guess that could point somewhere else.
  const { gcLogPath, jfrPath, outDir } = await injectLaunch({
    command,
    args: cmdArgs,
    outDir: newCaptureDir(),
    // Defaults to pulse's own cwd, not the target command's — e.g. a Spring
    // Boot app whose `config/` directory is resolved relative to the process
    // cwd needs `--cwd <project-dir>` unless pulse is already invoked from there.
    cwd: values.cwd,
    ...captureFlags(values),
  });
  await captureAndReport(outDir, { gcLogPath, jfrPath, label: values.label, command: [command, ...cmdArgs].join(" ") });
}

async function cmdAttach(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      pid: { type: "string" },
      docker: { type: "string" },
      duration: { type: "string" },
      label: { type: "string" },
      "jfr-max-mb": { type: "string" },
    },
  });
  const transport = values.docker ? { type: "docker", container: values.docker } : { type: "local" };
  const { gcLogPath, jfrPath, outDir } = await attach({
    pid: values.pid,
    transport,
    outDir: newCaptureDir(),
    ...captureFlags(values),
  });
  await captureAndReport(outDir, { gcLogPath, jfrPath, label: values.label });
}

async function cmdCompare(argv) {
  const [runId, baselineId] = argv;
  if (!runId || !baselineId) fail("compare requires <runId> <baselineRunId>");
  const [selected, baseline] = await Promise.all([loadRun(runId), loadRun(baselineId)]);
  if (!selected) fail(`run not found: ${runId}`);
  if (!baseline) fail(`run not found: ${baselineId}`);
  const htmlPath = await writeStaticCompare(baseline, selected);
  console.log(`Compare report: ${htmlPath}`);
}

async function cmdSweep(argv) {
  if (argv.length < 2) fail("sweep requires 2+ <runId> arguments, in the order you want them compared");
  const reports = await Promise.all(argv.map((runId) => loadRun(runId)));
  const missing = argv.filter((runId, i) => !reports[i]);
  if (missing.length) fail(`run(s) not found: ${missing.join(", ")}`);
  const htmlPath = await writeStaticSweep(reports);
  console.log(`Sweep report: ${htmlPath}`);
}

async function cmdAnalyzePrompt(argv) {
  const { values } = parseArgs({ args: argv, options: { run: { type: "string" } } });
  const report = values.run ? await loadRun(values.run) : await loadLatest();
  if (!report) fail(values.run ? `run not found: ${values.run}` : "no analysis available yet — run `pulse run`/`pulse attach`/`pulse ingest` first");
  const { prompt } = buildAnalysisPrompt(report);
  console.log(prompt);
  console.log(`\n---\nFull report: ${report.artifacts?.dir}/report.json`);
  if (report.artifacts?.views) console.log(`Full jfr views: ${report.artifacts.views}`);
}

async function main() {
  // Scope run history to whatever project the CLI is invoked against —
  // the same reason extension.mjs calls this for the canvas — so pointing
  // pulse at rating-engine and then at a different project doesn't mix
  // their run histories together in one shared directory.
  configureWorkspace(process.cwd());

  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case "ingest": return cmdIngest(rest);
    case "run": return cmdRun(rest);
    case "attach": return cmdAttach(rest);
    case "compare": return cmdCompare(rest);
    case "sweep": return cmdSweep(rest);
    case "analyze-prompt": return cmdAnalyzePrompt(rest);
    default:
      fail("usage: pulse <ingest|run|attach|compare|sweep|analyze-prompt> ...");
  }
}

main().catch((err) => fail(err.message));
