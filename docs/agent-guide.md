# jvm-pulse agent guide

## Install

No install step beyond having this repo checked out and a JDK with `jfr`
and `jcmd` on `PATH` (JDK 11+; `jcmd` ships with a JDK, not a JRE). The
first `pulse` invocation lazily bootstraps `jbang` if it isn't already
installed — see the main `README.md`.

## Capture recipes

### Local launch (a runnable jar, a JMH benchmark)

    node bin/pulse.mjs run --label "<what this is>" -- java -jar your-app.jar

For a long-running service (doesn't exit on its own), add `--duration 30s`
(or however long covers representative activity) — the process is stopped
and its JFR recording finalized automatically at that point.

Prefer a direct `java -jar`/`java -cp ...` invocation over a build-tool
wrapper (`mvn spring-boot:run`, `gradle bootRun`) here: `pulse run` reports
the gc-log/JFR of whatever process it directly spawned, and a wrapper
spawns the real application JVM as its own child with a *different* pid —
`pulse run`'s report would then describe the wrapper's own trivial GC
activity, not your application's. For a build-tool-launched app, use
`pulse attach --pid <the app JVM's own pid>` once it's up instead.

If the target app resolves its own config relative to its own project
directory (e.g. Spring Boot's `config/` convention), pass
`--cwd <target-project-dir>` — `pulse run`'s child process otherwise
inherits the CLI's own working directory, not the target's, which can
make the app fail to find its config and crash on boot.

Validated end-to-end against a real Spring Boot service (Boot 4.1, Java
25): the JVM needed no flag adjustment for `-Xlog:gc*`/
`-XX:StartFlightRecording` to work, and the packaged exec jar picked up
`JDK_JAVA_OPTIONS` cleanly with no extra config. `--duration 30s` was
enough for a smoke-test boot; a real multi-minute workload (driven by an
external e2e suite) used `--duration 10m` to safely bracket the whole
run — size `--duration` to the workload, not the other way around, since
`pulse run` kills the child process when it elapses.

### Attach to an already-running JVM

    node bin/pulse.mjs attach --pid <pid> --duration 30s

No restart needed — this dynamically enables GC logging and starts a JFR
recording on a JVM that's already up. Note this only captures the
attach-to-stop window, not the JVM's full lifetime — an attach-mode run
against an already-warm process will show a quieter GC profile than a
`pulse run` capture of the same app from cold start (less classloading/
startup allocation churn to see).

### Attach inside a Docker container

    node bin/pulse.mjs attach --docker <container-name> --duration 30s

The in-container java PID is discovered automatically (via `jps`, with a
PID-1 fallback if that's unavailable — don't pass `--pid` here). Requires
the container's base image to include a JDK (`jcmd` isn't part of a JRE);
a clear error is printed if it's missing, with a suggestion to use
`pulse run` instead.

**The base image must also be glibc-linked, not musl/Alpine** — validated
end-to-end against a real Dockerized deployment: PID auto-discovery via
`jps` worked reliably on both Alpine and Ubuntu-based images tested, and
`docker cp` needed no permission workaround, but musl/Alpine images
cannot produce JFR data at all (see Known limitations below for the full
root cause and a confirmed-working, no-size-penalty base image). Worth
checking `docker exec <container> sh -c "ldd --version"` up front if
you're unsure which libc a target image uses.

### Artifacts already on disk (CI)

    node bin/pulse.mjs ingest --gc-log <path> [--jfr <path>] [--label ...] [--command ...]

No capture step at all — analyzes and renders a report from files a CI job
already produced.

## CLI reference

```
pulse ingest --gc-log <path> [--jfr <path>] [--label <str>] [--command <str>]
pulse run [--duration <dur>] [--jfr-max-mb <n>] [--label <str>] [--cwd <dir>] -- <command...>
pulse attach [--pid <n> | --docker <container>] [--duration <dur>] [--label <str>] [--jfr-max-mb <n>]
pulse compare <runId> <baselineRunId>
pulse analyze-prompt [--run <runId>]
```

`--duration` accepts `<n>ms`, `<n>s`, or `<n>m` (e.g. `30s`, `500ms`, `2m`).

## Recommended workflow for JVM tuning

1. **Capture** a representative workload — `pulse run` for a fresh JVM
   (catches startup/classloading GC churn), `pulse attach` for the
   steady-state behavior of an already-running process.
2. **Triage fast, no agent needed** — open `report.html` and check the
   Healthy/Attention/Critical banner at the top and its KPI chips
   (throughput, p99 pause, allocation rate, peak-heap ratio). This is a
   fixed, deterministic set of thresholds baked into every report, not an
   AI feature — it's enough on its own to tell you whether GC is the
   bottleneck and which lever matters most.
3. **Deep recommendation, only if step 2 flags something** — run
   `pulse analyze-prompt [--run <runId>]` and hand its output to an
   LLM/agent. Unlike the banner, this command does not generate a
   recommendation itself — it prints a structured prompt (the full GC/JFR
   telemetry plus an instruction to produce actionable recommendations)
   for an agent to reason over. The Claude Code `/pulse-analyze` command
   and the `.github/prompts/pulse-analyze.prompt.md` file both wire this
   up as a one-shot slash command.
4. **Verify, don't guess** — after applying a suggested change, re-capture
   and run `pulse compare <newRunId> <baselineRunId>` to confirm it
   actually moved throughput/pause/alloc-rate in the right direction.

## Known limitations

- Attach-mode captures measure only the attach-to-stop window, not the JVM's
  full lifetime — GC events before the attach are permanently unrecoverable
  (dynamic logging has no retroactive backfill). Don't treat an attach-mode
  run as equivalent to a full launch-to-exit `pulse run` when comparing.
- `pulse run`'s inject-launch mechanism (`JDK_JAVA_OPTIONS`) affects every
  java launcher in the spawned process tree, including a wrapper's own
  bootstrap JVM (e.g. Maven's launcher when running `mvn spring-boot:run`).
  Output filenames are PID-templated so nothing collides, but `pulse run`
  itself analyzes the gc-log/JFR of whatever process it *directly* spawned
  — for a wrapper command, that's the wrapper's own trivial GC activity,
  not your actual application (which the wrapper forks as its own child,
  under a different pid). Use a direct `java -jar`/`java -cp` invocation
  with `pulse run`, or `pulse attach --pid <app pid>` for anything launched
  through a build-tool wrapper.
- `JDK_JAVA_OPTIONS` does not reach inside a container started via
  `docker run` — that requires explicitly forwarding
  `-e JDK_JAVA_OPTIONS=...` into the `docker run` invocation. `pulse attach
  --docker` is the supported path for containerized JVMs; `pulse run` is
  for local (non-containerized) processes.
- No Kubernetes-native transport (`kubectl exec`) yet — `attach --docker`
  covers Docker/Compose only.
- The CLI and the Copilot canvas share the same on-disk `runs/` history
  (`lib/pipeline.mjs` keys it off a workspace-hash directory) with no
  locking between the two processes. Running the CLI and having the canvas
  open at the same time is fine but not coordinated — the canvas's run
  picker may show CLI-produced runs, and `latest.json` reflects whichever
  process analyzed most recently. This is an accepted tradeoff, not a bug.
- **Windows requires Git for Windows** (`bash.exe`) for GC-log analysis —
  there's no `/bin/sh` on plain Windows, and the jbang-driven GC-log
  analyzer needs a POSIX shell to run. Without it, GC-derived panels/KPIs
  come back empty rather than erroring loudly. Set `PULSE_POSIX_SHELL` to
  override the shell path if it's not in a standard location. Linux/macOS
  are unaffected (they already have `/bin/sh`) but were not independently
  re-verified end-to-end this session — all testing ran the `pulse` CLI
  itself on a Windows host, so this is a flagged gap, not an assumption of
  cleanliness.
- **`pulse attach --docker` requires a glibc-linked JDK in the target
  container — musl/Alpine images cannot produce JFR data at all**, even
  with Alpine's `gcompat` shim installed (tested and ruled out: the JVM
  binary itself is musl-native, not just its dependencies, so there's
  nothing for a compat shim to intercept). Symptom on a musl image: `jcmd`
  commands all appear to succeed, but `JFR.stop`/`JFR.dump` report
  `Unable to complete I/O operation` / `Could not copy recording data. Not
  supported`, and every output file is 0 bytes. Confirmed-working, no
  image-size-penalty option: `eclipse-temurin:*-jdk-jammy` (Ubuntu).
  `jcmd` (required for `attach`) also ships only with a JDK, never a JRE —
  a JRE-only production image can't be attached to at all; the
  alternative there is setting
  `JDK_JAVA_OPTIONS`/`-XX:StartFlightRecording=...,dumponexit=true`
  manually at container start (no jcmd needed), at the cost of requiring a
  restart to enable profiling.
- `pulse run --cwd` matters for any target app whose config resolution is
  relative to its own project directory (e.g. Spring Boot's `config/`
  convention) — `pulse run`'s child process otherwise inherits the CLI's
  own working directory, not the target's.
