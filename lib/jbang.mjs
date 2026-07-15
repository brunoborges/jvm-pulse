// jbang bootstrap: resolve a usable jbang, or — on a JDK-only machine — lazily
// download the jbang distribution and drive it through the JDK, so the only
// hard prerequisite for this project is a JDK.
//
// jbang's jar is a *command generator*, not a runner. Running
//   java -classpath jbang.jar dev.jbang.Main run script.java args…
// prints a `java -classpath … MainClass args` line and exits with the sentinel
// code 255, which jbang's own wrapper scripts then `eval "exec $output"`. We
// reproduce that contract here. When a native `jbang` binary is present we use
// it directly (it performs the exec itself).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const execFileAsync = promisify(execFile);

// Pinned for reproducibility; override with JBANG_PULSE_VERSION if needed.
export const JBANG_VERSION = process.env.JBANG_PULSE_VERSION || "0.139.3";

const CACHE_DIR = join(homedir(), ".jvm-pulse");
const DIST_DIR = join(CACHE_DIR, `jbang-${JBANG_VERSION}`);
const JBANG_JAR = join(DIST_DIR, "bin", "jbang.jar");
// Self-contained jbang home for the downloaded distribution so its dependency
// cache (GCToolkit jars, etc.) stays isolated from any user-level ~/.jbang.
const JBANG_DIR = join(CACHE_DIR, ".jbang");

function firstExisting(candidates) {
    for (const c of candidates) {
        if (c && existsSync(c)) return c;
    }
    return null;
}

/**
 * Resolve a POSIX shell capable of `sh -c "exec …"` for running jbang's
 * generated command line. Plain Windows has no `/bin/sh` — this looks for
 * Git for Windows' bundled bash (the de facto standard POSIX shell on
 * Windows dev machines, and the one this project's own tooling already
 * depends on). `PULSE_POSIX_SHELL` overrides for anything unusual.
 */
export function resolvePosixShell() {
    if (process.env.PULSE_POSIX_SHELL) return process.env.PULSE_POSIX_SHELL;
    if (process.platform !== "win32") return "/bin/sh";

    const candidates = [
        "C:\\Program Files\\Git\\bin\\bash.exe",
        "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
        "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    ];
    for (const dir of (process.env.PATH || "").split(";")) {
        if (dir) candidates.push(join(dir, "bash.exe"));
    }
    const found = firstExisting(candidates);
    if (!found) {
        throw new Error(
            "pulse needs a POSIX shell to run its GC-log analyzer via jbang, but none was found " +
            "on this Windows machine. Install Git for Windows (ships bash.exe as a side effect) " +
            "— https://git-scm.com/download/win — or set PULSE_POSIX_SHELL to a bash/sh executable path."
        );
    }
    return found;
}

/** Resolve the `java`/`jar`/… launcher from JAVA_HOME, falling back to PATH. */
export function javaTool(tool = "java") {
    if (process.env.JAVA_HOME) {
        const p = join(process.env.JAVA_HOME, "bin", tool);
        if (existsSync(p)) return p;
    }
    return tool; // rely on PATH
}

/** Locate a natively-installed `jbang` binary, or null if none is present. */
export function resolveNativeJbang() {
    const cands = [
        join(homedir(), ".jbang", "bin", "jbang"),
        "/opt/homebrew/bin/jbang",
        "/usr/local/bin/jbang",
    ];
    for (const dir of (process.env.PATH || "").split(":")) {
        if (dir) cands.push(join(dir, "jbang"));
    }
    return firstExisting(cands);
}

/**
 * Ensure a usable jbang is available and return a descriptor:
 *   { kind: "native", bin }                — a native jbang binary
 *   { kind: "jar", java, jar, jbangDir }   — lazily-downloaded jbang.jar
 * Downloads (once) into ~/.jvm-pulse using only the JDK (`jar` for extraction)
 * and Node's built-in fetch — no curl/unzip/bash required.
 */
export async function ensureJbang(onProgress = () => {}) {
    // JBANG_PULSE_FORCE_DOWNLOAD lets tests exercise the JDK-only download path
    // even on machines that already have a native jbang installed.
    const forceDownload = !!process.env.JBANG_PULSE_FORCE_DOWNLOAD;
    const native = forceDownload ? null : resolveNativeJbang();
    if (native) return { kind: "native", bin: native };

    if (existsSync(JBANG_JAR)) {
        return { kind: "jar", java: javaTool("java"), jar: JBANG_JAR, jbangDir: JBANG_DIR };
    }

    await mkdir(CACHE_DIR, { recursive: true });
    const url = `https://github.com/jbangdev/jbang/releases/download/v${JBANG_VERSION}/jbang-${JBANG_VERSION}.zip`;
    onProgress(`Downloading jbang ${JBANG_VERSION} (first run only)…`);
    const res = await fetch(url);
    if (!res.ok || !res.body) {
        throw new Error(`jbang download failed: ${res.status} ${res.statusText} (${url})`);
    }
    const zip = join(CACHE_DIR, `jbang-${JBANG_VERSION}.zip`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(zip));

    onProgress("Extracting jbang with the JDK…");
    // The JDK ships `jar`, so we never need an external unzip.
    await execFileAsync(javaTool("jar"), ["-xf", zip], { cwd: CACHE_DIR });
    await rm(zip, { force: true });

    if (!existsSync(JBANG_JAR)) {
        throw new Error(`jbang.jar not found after extraction at ${JBANG_JAR}`);
    }
    return { kind: "jar", java: javaTool("java"), jar: JBANG_JAR, jbangDir: JBANG_DIR };
}

/**
 * Run jbang with the given args (e.g. ["run", "Script.java", "arg"]).
 * For a native jbang the binary execs the target itself. For the downloaded
 * jar we honor jbang's exit-255 sentinel and exec the generated command line
 * through the shell, returning the target program's stdout/stderr.
 */
export async function runJbang(descriptor, jbangArgs, execOpts = {}) {
    if (descriptor.kind === "native") {
        return execFileAsync(descriptor.bin, jbangArgs, execOpts);
    }

    const env = {
        ...process.env,
        JBANG_DIR: descriptor.jbangDir,
        JBANG_RUNTIME_SHELL: "bash",
        JBANG_STDIN_NOTTY: "true",
    };

    let cmdLine;
    try {
        const { stdout } = await execFileAsync(
            descriptor.java,
            ["-classpath", descriptor.jar, "dev.jbang.Main", ...jbangArgs],
            { maxBuffer: 16 * 1024 * 1024, env },
        );
        // Exit 0: informational output (e.g. `version`); nothing to exec.
        return { stdout, stderr: "" };
    } catch (e) {
        if (e && e.code === 255 && typeof e.stdout === "string") {
            cmdLine = e.stdout.trim();
        } else {
            throw e;
        }
    }

    // exit 255: stdout is a command line for the wrapper to `eval "exec …"`.
    return execFileAsync(resolvePosixShell(), ["-c", `exec ${cmdLine}`], { ...execOpts, env });
}

/** A sync, display-only snapshot of how jbang will be provided. */
export function describeJbang() {
    const native = resolveNativeJbang();
    if (native) return { mode: "native", path: native };
    if (existsSync(JBANG_JAR)) return { mode: "downloaded", path: JBANG_JAR, version: JBANG_VERSION };
    return { mode: "auto-download", path: JBANG_JAR, version: JBANG_VERSION };
}
