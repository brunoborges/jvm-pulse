import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAnalysisPrompt, buildRunPrompt } from "../lib/prompt.mjs";

test("analysis advice includes JFR limitations rather than treating missing hotspots as zero activity", () => {
  const warning = "jfr view requires JDK 21+; re-ingest the same recording";
  const { prompt } = buildAnalysisPrompt({ jfr: { warnings: [warning], error: "CPU load extraction failed" } });
  assert.match(prompt, /## JFR analysis limitations/);
  assert.ok(prompt.includes(warning));
  assert.ok(prompt.includes("CPU load extraction failed"));
  assert.match(prompt, /Missing analysis is not evidence of zero activity/);
});

test("reports without JFR warnings keep the analysis prompt free of a limitations section", () => {
  assert.doesNotMatch(buildAnalysisPrompt({ jfr: {} }).prompt, /## JFR analysis limitations/);
});

test("analysis advice only claims a raw views attachment when one exists", () => {
  const report = { artifacts: { dir: "/run" } };
  const withoutViews = buildAnalysisPrompt(report);
  assert.equal(withoutViews.attachments.length, 1);
  assert.doesNotMatch(withoutViews.prompt, /text report is also attached/);
  const withViews = buildAnalysisPrompt({ artifacts: { ...report.artifacts, views: "/run/jfr-views.txt" } });
  assert.equal(withViews.attachments.length, 2);
  assert.match(withViews.prompt, /text report is also attached/);
});

test("capture instructions distinguish the workload JVM from the analysis JDK", () => {
  const { prompt } = buildRunPrompt();
  assert.match(prompt, /GC analysis needs JDK 17\+/);
  assert.match(prompt, /jfr` tool from JDK 21\+/);
  assert.match(prompt, /JFR \(JDK 11\+\)/);
});
