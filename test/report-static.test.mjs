import { test } from "node:test";
import assert from "node:assert/strict";
import { renderStaticReportHtml, renderStaticCompareHtml, renderStaticSweepHtml, writeStaticCompare, writeStaticSweep } from "../lib/report-static.mjs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SAMPLE_REPORT = {
  runId: "2026-07-15T12-00-00-000Z",
  label: "sample run",
  generatedAt: "2026-07-15T12:00:00.000Z",
  gc: { summary: { throughputPercent: 98.4, eventCount: 12 }, causes: {}, types: {}, events: [] },
  jfr: { available: true },
  gcConfig: {},
  jvm: {},
  source: {},
};

test("renderStaticReportHtml embeds the report JSON and the render functions, with no live-server calls", async () => {
  const html = await renderStaticReportHtml(SAMPLE_REPORT);
  assert.ok(html.includes("sample run"), "title should include the run label");
  assert.ok(html.includes(JSON.stringify(SAMPLE_REPORT)), "report JSON should be embedded verbatim");
  assert.ok(html.includes("function renderReport"), "render.js content should be inlined");
  assert.ok(!html.includes("EventSource"), "must not include canvas app-wiring (EventSource)");
  assert.ok(!html.includes('fetch("runs")'), "must not include canvas app-wiring (fetch)");
  assert.ok(!html.includes('el("run-btn")'), "must not include canvas-only DOM element references");
});

test("renderStaticReportHtml embeds the jfr views text so #views-pre isn't left permanently Loading", async () => {
  // In the live canvas app.js fetches the views text and fills #views-pre;
  // a static report has no server, so the text must be embedded at generation
  // time or the section spins on "Loading…" forever.
  const root = await mkdtemp(join(tmpdir(), "pulse-views-"));
  const viewsPath = join(root, "jfr-views.txt");
  const viewsText = "== GC Configuration ==\nvalue with </script> breakout attempt";
  try {
    await writeFile(viewsPath, viewsText);
    const html = await renderStaticReportHtml({ ...SAMPLE_REPORT, artifacts: { views: viewsPath } });
    assert.ok(html.includes('getElementById("views-pre")'), "should wire up filling of #views-pre");
    assert.ok(html.includes(JSON.stringify(viewsText).replace(/</g, "\\u003c")), "views text should be embedded, escaped");
    assert.ok(!html.includes("</script>value"), "raw </script> in views text must not break out of the embed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("renderStaticReportHtml marks views unavailable rather than spinning when the file is missing", async () => {
  const html = await renderStaticReportHtml({ ...SAMPLE_REPORT, artifacts: { views: "/no/such/jfr-views.txt" } });
  assert.ok(html.includes("(unavailable)"), "a truthy-but-unreadable views path should render as unavailable");
});

test("renderStaticCompareHtml embeds both reports and calls renderCompare", async () => {
  const b = { ...SAMPLE_REPORT, runId: "baseline" };
  const html = await renderStaticCompareHtml(b, SAMPLE_REPORT);
  assert.ok(html.includes("renderCompare(BASELINE, SELECTED)"));
  assert.ok(html.includes(JSON.stringify(b)));
  assert.ok(html.includes(JSON.stringify(SAMPLE_REPORT)));
});

test("renderStaticSweepHtml embeds all N reports and calls renderSweep", async () => {
  const runs = [
    { ...SAMPLE_REPORT, runId: "run-1g", label: "1GB heap" },
    { ...SAMPLE_REPORT, runId: "run-2g", label: "2GB heap" },
    { ...SAMPLE_REPORT, runId: "run-4g", label: "4GB heap" },
  ];
  const html = await renderStaticSweepHtml(runs);
  assert.ok(html.includes("renderSweep(REPORTS)"));
  for (const r of runs) assert.ok(html.includes(JSON.stringify(r)), `${r.label} should be embedded verbatim`);
});

test("renderStaticReportHtml escapes </script> in embedded JSON to prevent stored XSS", async () => {
  const payload = "</script><script>alert(1)</script>";
  const malicious = { ...SAMPLE_REPORT, label: payload };
  const html = await renderStaticReportHtml(malicious);
  assert.ok(!html.includes(payload), "the raw breakout payload must not appear literally in the output");
  assert.ok(html.includes("\\u003c/script>\\u003cscript>alert(1)\\u003c/script>"), "the payload should survive escaped inside the JSON embed");
});

test("writeStaticCompare doesn't collide when two comparisons share one run", async () => {
  const root = await mkdtemp(join(tmpdir(), "pulse-compare-"));
  const mk = (runId, label) => ({ ...SAMPLE_REPORT, runId, label, artifacts: { dir: join(root, runId) } });
  const shared = mk("run-shared", "shared baseline");
  try {
    const pathA = await writeStaticCompare(shared, mk("run-a", "candidate A"));
    const pathB = await writeStaticCompare(shared, mk("run-b", "candidate B"));
    assert.notEqual(pathA, pathB, "two comparisons sharing one run must not write to the same file");
    const [htmlA, htmlB] = await Promise.all([readFile(pathA, "utf8"), readFile(pathB, "utf8")]);
    assert.ok(htmlA.includes("candidate A") && !htmlA.includes("candidate B"), "A's compare.html must not have been overwritten by B's comparison");
    assert.ok(htmlB.includes("candidate B"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writeStaticSweep doesn't collide when two sweeps share their last run", async () => {
  const root = await mkdtemp(join(tmpdir(), "pulse-sweep-"));
  const mk = (runId, label) => ({ ...SAMPLE_REPORT, runId, label, artifacts: { dir: join(root, runId) } });
  const shared = mk("run-shared", "shared current");
  try {
    const pathX = await writeStaticSweep([mk("run-x1", "x1"), mk("run-x2", "x2"), shared]);
    const pathY = await writeStaticSweep([mk("run-y1", "y1"), mk("run-y2", "y2"), shared]);
    assert.notEqual(pathX, pathY, "two sweeps sharing one run must not write to the same file");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
