// Lightweight checks on web/*.js as static assets — render.js is loaded (as
// a classic, non-module script, matching how the browser and
// lib/report-static.mjs both consume it) into a vm context so its chart
// functions can be exercised directly, without a real browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..", "web");

test("app.js runs in strict mode", () => {
  const src = readFileSync(join(WEB_DIR, "app.js"), "utf8");
  assert.match(src.trimStart(), /^"use strict";/, 'app.js must open with "use strict" — it holds all the state/SSE wiring that used to be covered by the single pre-split app.js');
});

test("sweepTrendChart plots every run within the chart's viewBox, even when a middle run is missing the metric", () => {
  const src = readFileSync(join(WEB_DIR, "render.js"), "utf8");
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);

  const w = 560;
  // Run 3 of 5 is missing (filtered out upstream, e.g. zero GC events), so
  // `t` values skip from 2 to 4 — xmax must still reflect all 5 runs.
  const svg = sandbox.sweepTrendChart(
    [
      { t: 1, v: 10, label: "run 1" },
      { t: 2, v: 20, label: "run 2" },
      { t: 4, v: 40, label: "run 4" },
      { t: 5, v: 50, label: "run 5" },
    ],
    { w, runCount: 5 }
  );
  const cxValues = [...svg.matchAll(/cx="([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.equal(cxValues.length, 4);
  for (const cx of cxValues) {
    assert.ok(cx >= 0 && cx <= w, `expected every dot's cx within the ${w}-wide viewBox, got ${cx}`);
  }
});
