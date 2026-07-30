---
description: Attach jvm-pulse to a JVM that's already running (local pid or a container) and produce a report
---

Ask (if not already given): a local pid, or a Docker container name?

- Local pid: `node "${CLAUDE_PLUGIN_ROOT}/bin/pulse.mjs" attach --pid <pid> --duration <dur>`
- Container: `node "${CLAUDE_PLUGIN_ROOT}/bin/pulse.mjs" attach --docker <container> --duration <dur>`
  (the in-container java pid is auto-discovered — no need to ask for it)

`--duration` should cover a representative window of activity — ask what the
service is doing right now, or how long to wait for representative traffic.

If `--docker` fails with a jcmd/JDK error, the target container's base image
is either JRE-only (jcmd ships only with a JDK) or musl/Alpine-based (JFR's
recording write is broken under musl, even with `gcompat` installed — a
genuinely glibc-linked JDK image is required, e.g. Debian/Ubuntu/Amazon-Linux
based, not Alpine). Report this back to the user rather than retrying blindly.

Then open `<path>/report.html` and visually confirm it renders — real KPI
numbers, no blank panels, no visible JS error. Don't just relay the printed
path: only actually looking catches real bugs (a Docker/JVM libc mismatch,
a Windows-only crash, a force-kill silently losing JFR data all surfaced
this way). If you have no way to open a browser, read `report.json`'s
`gc.summary`/`jfr.available` fields directly and summarize the real numbers
instead of only relaying the file path.
