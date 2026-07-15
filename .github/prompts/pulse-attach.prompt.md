---
description: Attach jvm-pulse to a JVM that's already running (local pid or a container) and produce a report
agent: agent
---

Ask (if not already given): a local pid, or a Docker container name?

- Local pid: `node bin/pulse.mjs attach --pid <pid> --duration <dur>`
- Container: `node bin/pulse.mjs attach --docker <container> --duration <dur>`
  (the in-container java pid is auto-discovered — no need to ask for it)

`--duration` should cover a representative window of activity.

If `--docker` fails with a jcmd/JDK error, the target container's base image
is either JRE-only (jcmd ships only with a JDK) or musl/Alpine-based (JFR's
recording write is broken under musl, even with `gcompat` installed — a
genuinely glibc-linked JDK image is required, e.g. Debian/Ubuntu/Amazon-Linux
based, not Alpine). Report this back to the user rather than retrying blindly.

Report the printed `Report: <path>/report.html` path back to the user.
