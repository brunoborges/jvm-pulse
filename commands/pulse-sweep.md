---
description: Compare 3+ jvm-pulse runs (e.g. a heap-size or GC-flag sweep) into a single trend report
---

Use this instead of `/pulse:compare` whenever there are 3 or more runs to
compare — `compare` is a two-run baseline/selected delta view; `sweep` is
built for an ordered set (e.g. `-Xmx1g`/`-Xmx2g`/`-Xmx4g` against the same
workload) and highlights the best value per metric plus trend charts across
the whole set, not just a single before/after delta.

If not specified, ask which runs to include and in what order — list
`runs/*/report.json` directories (newest first). Order matters only for
labeling (run 1, run 2, ...), not for which one "wins" a metric.

Run: `node "${CLAUDE_PLUGIN_ROOT}/bin/pulse.mjs" sweep <runId1> <runId2> [<runId3> ...]`

Then open `<path>/sweep.html` and visually confirm the table and trend
charts render correctly — don't just relay the printed path. Point out
anything counterintuitive in the trends (e.g. a metric that gets *worse*
partway through the sweep, not just monotonically better) — that's usually
the most useful finding in a sweep, and it's easy to miss by only reading
the raw numbers instead of looking at the chart.
