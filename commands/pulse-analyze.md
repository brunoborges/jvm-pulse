---
description: Analyze the latest jvm-pulse GC/JFR report and recommend JVM tuning + code optimizations
---

Run `node bin/pulse.mjs analyze-prompt` (add `--run <runId>` to target a
specific past run) and read its output — it contains the GC/JFR metrics from
that run. Using those numbers, provide:

1. **GC health assessment** — is throughput/pause behavior healthy for this workload?
2. **JVM flag recommendations** — concrete `-XX` flags or collector choices, with reasoning.
3. **Allocation/code hotspots** — from the top allocations and hot methods, which application code paths are worth optimizing.
4. **Concurrency & latency signals** — if lock contention, safepoint, exception, or slow-I/O data is present, call out anything hurting latency beyond GC.
5. **Suggested next experiment** — the single most valuable follow-up run.

Ground every recommendation in the numbers from the command's output.
