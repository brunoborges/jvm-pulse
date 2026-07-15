// Renders a report.json (and optionally a baseline for comparison) to a
// single self-contained HTML file — no server, opens via file://, works as
// a CI artifact. Reuses web/render.js's pure chart/report functions (shared
// with the Copilot canvas) rather than the canvas's live-server app.js.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..", "web");

async function readWebAsset(name) {
  return readFile(join(WEB_DIR, name), "utf8");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// JSON.stringify never escapes "<", so a field containing "</script>" (a PR
// title, a JFR string-table entry, ...) would close the embedding <script>
// tag early and let arbitrary markup execute. Escape it out of the JS string.
function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function page(title, css, renderJs, bodyScript) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>${css}</style>
</head>
<body>
<main id="content"><div id="report" class="report"></div></main>
<script>${renderJs}</script>
<script>${bodyScript}</script>
</body>
</html>`;
}

/** Render a single report to a self-contained static HTML string. */
export async function renderStaticReportHtml(report) {
  const [css, renderJs] = await Promise.all([readWebAsset("styles.css"), readWebAsset("render.js")]);
  const title = report?.label ? `JVM Pulse — ${report.label}` : "JVM Pulse report";
  const bodyScript = `
const REPORT = ${jsonForScript(report)};
document.addEventListener("DOMContentLoaded", () => {
  const el = document.getElementById("report");
  el.innerHTML = renderReport(REPORT);
  animateBars(el);
});`;
  return page(title, css, renderJs, bodyScript);
}

/** Render a comparison of two reports to a self-contained static HTML string. */
export async function renderStaticCompareHtml(baseline, selected) {
  const [css, renderJs] = await Promise.all([readWebAsset("styles.css"), readWebAsset("render.js")]);
  const bodyScript = `
const BASELINE = ${jsonForScript(baseline)};
const SELECTED = ${jsonForScript(selected)};
document.addEventListener("DOMContentLoaded", () => {
  const el = document.getElementById("report");
  el.innerHTML = renderCompare(BASELINE, SELECTED);
  animateBars(el);
});`;
  return page("JVM Pulse — comparison", css, renderJs, bodyScript);
}

/** Render + write report.html next to report.json in the run's artifact dir. */
export async function writeStaticReport(report) {
  const html = await renderStaticReportHtml(report);
  const outPath = join(report.artifacts.dir, "report.html");
  await writeFile(outPath, html);
  return outPath;
}

/** Render + write compare.html (into the selected run's directory) for two runs. */
export async function writeStaticCompare(baseline, selected) {
  const html = await renderStaticCompareHtml(baseline, selected);
  const outPath = join(selected.artifacts.dir, "compare.html");
  await writeFile(outPath, html);
  return outPath;
}
