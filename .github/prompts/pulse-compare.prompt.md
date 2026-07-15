---
description: Compare two jvm-pulse runs into a single diff report
agent: agent
---

If not specified, ask which two runs to compare — list `runs/*/report.json`
directories (newest first), or use the two most recent if asked to "compare
the last two runs".

Run: `node bin/pulse.mjs compare <selectedRunId> <baselineRunId>`

Report the printed `Compare report: <path>/compare.html` path back to the user.
