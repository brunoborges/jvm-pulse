#!/usr/bin/env node
// CLI entry point: wires the capture primitives (lib/capture.mjs) and the
// static renderer (lib/report-static.mjs) around the existing, untouched
// analysis engine (lib/pipeline.mjs). Agent-agnostic — no Copilot SDK here.
import { parseArgs } from "node:util";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { copyFile, mkdir } from "node:fs/promises";
import { analyzeArtifacts, loadRun, loadLatest, configureWorkspace } from "../lib/pipeline.mjs";
import { injectLaunch, attach } from "../lib/capture.mjs";
import { writeStaticReport, writeStaticCompare } from "../lib/report-static.mjs";
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

  const outDir = join("runs", String(Date.now()));
  const { gcLogPath, jfrPath } = await injectLaunch({
    command,
    args: cmdArgs,
    outDir,
    // Defaults to pulse's own cwd, not the target command's — e.g. a Spring
    // Boot app whose `config/` directory is resolved relative to the process
    // cwd needs `--cwd <project-dir>` unless pulse is already invoked from there.
    cwd: values.cwd,
    jfrMaxMb: values["jfr-max-mb"] ? Number(values["jfr-max-mb"]) : undefined,
    durationMs: values.duration ? parseDuration(values.duration) : undefined,
  });
  const report = await analyzeArtifacts({
    gcLogPath,
    jfrPath,
    label: values.label,
    command: [command, ...cmdArgs].join(" "),
  });
  const htmlPath = await writeStaticReport(report);
  console.log(`Report: ${htmlPath}`);
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
  const outDir = join("runs", String(Date.now()));
  const { gcLogPath, jfrPath } = await attach({
    pid: values.pid,
    transport,
    outDir,
    jfrMaxMb: values["jfr-max-mb"] ? Number(values["jfr-max-mb"]) : undefined,
    durationMs: values.duration ? parseDuration(values.duration) : undefined,
  });
  const report = await analyzeArtifacts({ gcLogPath, jfrPath, label: values.label });
  const htmlPath = await writeStaticReport(report);
  console.log(`Report: ${htmlPath}`);
}

async function cmdCompare(argv) {
  const [runId, baselineId] = argv;
  if (!runId || !baselineId) fail("compare requires <runId> <baselineRunId>");
  const selected = await loadRun(runId);
  const baseline = await loadRun(baselineId);
  if (!selected) fail(`run not found: ${runId}`);
  if (!baseline) fail(`run not found: ${baselineId}`);
  const htmlPath = await writeStaticCompare(baseline, selected);
  console.log(`Compare report: ${htmlPath}`);
}

async function cmdAnalyzePrompt(argv) {
  const runFlagIdx = argv.indexOf("--run");
  const runId = runFlagIdx !== -1 ? argv[runFlagIdx + 1] : null;
  const report = runId ? await loadRun(runId) : await loadLatest();
  if (!report) fail(runId ? `run not found: ${runId}` : "no analysis available yet — run `pulse run`/`pulse attach`/`pulse ingest` first");
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
    case "analyze-prompt": return cmdAnalyzePrompt(rest);
    default:
      fail("usage: pulse <ingest|run|attach|compare|analyze-prompt> ...");
  }
}

main().catch((err) => fail(err.message));
