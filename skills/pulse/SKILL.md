---
name: pulse
description: Use when profiling a Java project's memory/GC behavior, diagnosing an OutOfMemoryError or GC pauses, or tuning JVM heap/collector settings. Captures GC+JFR telemetry (local launch, attached to an already-running JVM, or inside a container) and produces a shareable static HTML report.
---

# JVM Pulse

Profiles any Java project's garbage collection and JFR telemetry, producing a
self-contained `report.html` you can open in a browser or attach to a CI run.

Full capture recipes and the CLI reference live in this repo's `AGENTS.md`
and `docs/agent-guide.md` — that's the source of truth, not this file.

## Quick usage

- **Local process, you drive the workload:** `node bin/pulse.mjs run --label "<what this is>" -- <the launch command>` (add `--duration 30s` for a long-running service that doesn't exit on its own)
- **Already-running JVM:** `node bin/pulse.mjs attach --pid <n> --duration 30s` (or `--docker <container>` — the in-container pid is auto-discovered)
- **Artifacts already on disk:** `node bin/pulse.mjs ingest --gc-log <path> [--jfr <path>]`
- **Compare two runs:** `node bin/pulse.mjs compare <selectedRunId> <baselineRunId>`
- **Compare 3+ runs** (e.g. a heap-size or GC-flag sweep): `node bin/pulse.mjs sweep <runId1> <runId2> [<runId3> ...]`
- **Tuning recommendations from the last run:** `node bin/pulse.mjs analyze-prompt`, then read its output and answer it grounded in those numbers.

Pick the mode based on what's being profiled: a runnable jar/command → `run`;
a service that's already up → `attach`; CI artifacts already produced →
`ingest`. **Always open the resulting `report.html`/`compare.html`/`sweep.html`
and visually confirm it renders — real numbers, no blank panels — rather than
just relaying the printed path.** Real bugs (a broken JVM/Docker combination,
a platform-specific crash, a lost-data bug) have only ever been caught this
way, not by trusting a clean exit code.
