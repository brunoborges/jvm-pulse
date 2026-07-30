---
description: Report the most recent jvm-pulse report without re-running anything
---

Find the most recently modified `runs/*/report.html` (there's no separate
CLI subcommand for this — it's a plain file lookup) and open it — don't
just relay the path. If none exists yet, say so and suggest `/pulse:run` or
`/pulse:attach`.
