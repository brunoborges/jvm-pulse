---
description: Compare two jvm-pulse runs into a single diff report
---

If not specified, ask which two runs to compare — list `runs/*/report.json`
directories (newest first) and ask the user to pick two, or use the two most
recent if the user just says "compare the last two runs". Comparing 3 or
more runs (e.g. a heap-size or GC-flag sweep)? Use `/pulse:sweep` instead —
`compare` is specifically a two-run baseline/selected delta view.

Run: `node bin/pulse.mjs compare <selectedRunId> <baselineRunId>`

Then open `<path>/compare.html` and visually confirm the delta table and
verdict render correctly — don't just relay the printed path.
