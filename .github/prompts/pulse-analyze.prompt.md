---
description: Analyze the latest jvm-pulse GC/JFR report and recommend JVM tuning + code optimizations
agent: agent
---

Run `node bin/pulse.mjs analyze-prompt` (add `--run <runId>` for a specific
past run) and read its output. Using those numbers, provide:

1. GC health assessment
2. JVM flag recommendations (concrete `-XX` flags, with reasoning)
3. Allocation/code hotspots worth optimizing
4. Concurrency & latency signals (lock contention, safepoints, exceptions, slow I/O) if present
5. The single most valuable next experiment to run

Ground every recommendation in the numbers from the command's output.
