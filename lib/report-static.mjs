// Renders a report.json (and optionally a baseline for comparison) to a
// single self-contained HTML file — no server, opens via file://, works as
// a CI artifact. Reuses web/render.js's pure chart/report functions (shared
// with the Copilot canvas) rather than the canvas's live-server app.js.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

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

/** Render `title`/`vars`/`call` (a renderReport/renderCompare/renderSweep
 *  invocation expression referencing `vars`' keys) into a self-contained
 *  static HTML string. Shared by all three report kinds below. */
async function renderStaticHtml({ title, vars, call, postRender = "" }) {
  const [css, renderJs] = await Promise.all([readWebAsset("styles.css"), readWebAsset("render.js")]);
  const assigns = Object.entries(vars).map(([name, value]) => `const ${name} = ${jsonForScript(value)};`).join("\n");
  const bodyScript = `
${assigns}
document.addEventListener("DOMContentLoaded", () => {
  const el = document.getElementById("report");
  el.innerHTML = ${call};
  animateBars(el);
${postRender}
});`;
  return page(title, css, renderJs, bodyScript);
}

/** Render + write `name` under `dir` (created if needed), returning the path. */
async function writeStatic(dir, name, html) {
  await mkdir(dir, { recursive: true });
  const outPath = join(dir, name);
  await writeFile(outPath, html);
  return outPath;
}

// A comparison/sweep artifact belongs to the SET of runs it covers, not to
// any one of them — writing it into an arbitrary constituent run's own
// directory means two comparisons that happen to share one run (e.g.
// several candidates against one fixed baseline) silently overwrite each
// other. Key the directory off all participating run ids instead.
function comparisonDir(baseDir, runIds) {
  const key = createHash("sha1").update(runIds.join(":")).digest("hex").slice(0, 12);
  return join(baseDir, "comparisons", key);
}

/** Render a single report to a self-contained static HTML string. */
export async function renderStaticReportHtml(report) {
  const title = report?.label ? `JVM Pulse — ${report.label}` : "JVM Pulse report";
  const vars = { REPORT: report };
  let postRender = "";
  // renderReport() emits a `#views-pre` element seeded with "Loading…" that the
  // live canvas fills via an app.js fetch. There's no server here, so embed the
  // `jfr view all-views` text at generation time — otherwise the section would
  // stay "Loading…" forever. (If the file is gone/unreadable, say so rather than
  // leaving it spinning.)
  if (report?.artifacts?.views) {
    let views;
    try { views = await readFile(report.artifacts.views, "utf8"); } catch { views = "(unavailable)"; }
    vars.VIEWS = views;
    postRender = `  const _pre = document.getElementById("views-pre"); if (_pre) _pre.textContent = VIEWS;`;
  }
  return renderStaticHtml({ title, vars, call: "renderReport(REPORT)", postRender });
}

/** Render a comparison of two reports to a self-contained static HTML string. */
export async function renderStaticCompareHtml(baseline, selected) {
  return renderStaticHtml({
    title: "JVM Pulse — comparison",
    vars: { BASELINE: baseline, SELECTED: selected },
    call: "renderCompare(BASELINE, SELECTED)",
  });
}

/** Render an N-way sweep (e.g. a heap-size or GC-flag sweep) across an ordered
 * list of 2+ reports to a self-contained static HTML string. */
export async function renderStaticSweepHtml(reports) {
  return renderStaticHtml({ title: "JVM Pulse — sweep", vars: { REPORTS: reports }, call: "renderSweep(REPORTS)" });
}

/** Render + write report.html next to report.json in the run's artifact dir. */
export async function writeStaticReport(report) {
  const html = await renderStaticReportHtml(report);
  return writeStatic(report.artifacts.dir, "report.html", html);
}

/** Render + write compare.html into a dedicated dir keyed by both run ids. */
export async function writeStaticCompare(baseline, selected) {
  const html = await renderStaticCompareHtml(baseline, selected);
  const dir = comparisonDir(dirname(selected.artifacts.dir), [baseline.runId, selected.runId]);
  return writeStatic(dir, "compare.html", html);
}

/** Render + write sweep.html into a dedicated dir keyed by all run ids. */
export async function writeStaticSweep(reports) {
  const html = await renderStaticSweepHtml(reports);
  const dir = comparisonDir(dirname(reports[0].artifacts.dir), reports.map((r) => r.runId));
  return writeStatic(dir, "sweep.html", html);
}
