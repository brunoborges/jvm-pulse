# jvm-pulse — agent guide

jvm-pulse profiles a Java project's garbage collection and JFR (flight
recorder) telemetry and produces a shareable report. It works two ways:

- **Inside GitHub Copilot's app**, as a canvas extension (see `README.md`).
- **From any coding agent, or a plain CI step**, via the `bin/pulse.mjs` CLI
  — no Copilot dependency. This is what you're reading about here.

Full capture recipes, the CLI reference, and how to interpret a report:
see `docs/agent-guide.md`.

## Quick start

```
node bin/pulse.mjs run -- <your launch command>       # launch + capture
node bin/pulse.mjs attach --pid <n>                    # attach to a running JVM
node bin/pulse.mjs attach --docker <container>         # attach inside a container
node bin/pulse.mjs ingest --gc-log <path> [--jfr <path>]  # artifacts already on disk
node bin/pulse.mjs analyze-prompt                       # tuning-advice context from the last run
```

Every capture command prints the path to a self-contained `report.html` —
open it in a browser, or attach it as a CI artifact.
