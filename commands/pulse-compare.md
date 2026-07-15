---
description: Compare two jvm-pulse runs into a single diff report
---

If not specified, ask which two runs to compare — list `runs/*/report.json`
directories (newest first) and ask the user to pick two, or use the two most
recent if the user just says "compare the last two runs".

Run: `node bin/pulse.mjs compare <selectedRunId> <baselineRunId>`

Report the printed `Compare report: <path>/compare.html` path back to the user.
