import { test } from "node:test";
import assert from "node:assert/strict";
import { renderStaticReportHtml, renderStaticCompareHtml, renderStaticSweepHtml } from "../lib/report-static.mjs";

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
