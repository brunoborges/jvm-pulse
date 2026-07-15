---
description: Build/run this project's workload with GC+JFR capture, then produce a jvm-pulse report
---

Detect this project's build tool and a representative workload — prefer, in
order: an existing benchmark/JMH harness, a runnable jar/main class, or a
representative test. Ask the user if genuinely ambiguous. Avoid a build-tool
wrapper command (`mvn spring-boot:run`, `gradle bootRun`) as the launch
command itself — `pulse run` reports on whatever process it directly
spawns, and a wrapper forks the real app JVM as its own child under a
different pid, so the report would describe the wrong process.

Then run:

    node bin/pulse.mjs run --label "<short description>" -- <the launch command>

For a long-running service that doesn't exit on its own, add
`--duration 30s` (or however long is representative) so capture stops
automatically instead of hanging. If the target app resolves its own config
relative to its own project directory (e.g. Spring Boot's `config/`
convention) and `pulse` is being invoked from somewhere else, add
`--cwd <target-project-dir>` too — otherwise the app may fail to find its
config and crash on boot.

Then open `<path>/report.html` and visually confirm it renders — real KPI
numbers (not "–" placeholders throughout), no blank panels, no visible JS
error. Don't just relay the printed path: this only works if you actually
look — real bugs (a Docker/JVM libc mismatch, a Windows-only crash, a
force-kill silently losing JFR data) were only caught this way, not by
trusting a clean exit code. If you have no way to open a browser, read
`report.json`'s `gc.summary`/`jfr.available` fields directly and summarize
the real numbers instead of only relaying the file path.
