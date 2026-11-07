import { execFileSync, spawn } from "node:child_process";
import { win32 } from "node:path";
import { performance } from "node:perf_hooks";

// Runs one bounded child process, timing it and stopping only what it owns.

// A measurement ceiling, long enough to tell a slow command from a hung one. Not an app timeout.
export const PROBE_TIMEOUT_MS = 120_000;
export const TERMINATE_GRACE_MS = 5_000;
// The most one probe can take: the ceiling, taskkill's own limit and the wait for close.
export const LONGEST_PROBE_MS = PROBE_TIMEOUT_MS + 2 * TERMINATE_GRACE_MS;
// More output than any process table should need. Beyond it a target is reported as not compared.
export const MAX_RETAINED_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_LENGTH = 200;

/** Keeps one short line of an error, without paths, so a failure can be read but discloses nothing. */
export function sanitizeErrorLine(text) {
  const firstLine = text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
  return firstLine
    .replace(/[A-Za-z]:[\\/][^\s"']*/g, "<path>")
    .replace(/\\\\[^\s"']+/g, "<path>")
    .replace(/(^|\s)\/[^\s"']+/g, "$1<path>")
    .replace(/\d{6,}/g, "<number>")
    .trim()
    .slice(0, MAX_ERROR_LENGTH);
}

/**
 * Whether inspector output names this exact process, parsed as the inspector parses it: trimmed
 * first, which also removes a leading byte order mark. The output itself is never retained.
 */
function outputNamesPid(stdout, pid) {
  try {
    return JSON.parse(stdout.trim()).ProcessId === pid;
  } catch {
    return false;
  }
}

/**
 * Stops the one process this script spawned, by its recorded pid and never by name. The caller
 * only reaches this while that child has not exited. `taskkill /T` walks parent pids, which
 * Windows does not reserve, so this is best-effort cleanup on a disposable VM and not a proof
 * that every descendant is ours. A descendant that outlives it is left for the VM's disposal.
 */
function terminateOwnedChild(child) {
  if (process.platform !== "win32") {
    child.kill("SIGKILL");
    return;
  }
  const taskkill = win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
  try {
    execFileSync(taskkill, ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      timeout: TERMINATE_GRACE_MS,
      windowsHide: true,
    });
  } catch {
    child.kill("SIGKILL");
  }
}

/**
 * Runs one command with the same process shape as the app's execCommand: every stdio stream
 * piped, a hidden console and the caller's environment. Stdout is read only to measure it.
 * Resolves with timings once the process closes, or after a bounded wait past the ceiling. A
 * process that already exited is never signalled, even when something still holds its pipes.
 * @param {{ command: string, args: string[], stdin: "open" | "closed", timeoutMs?: number, ownPid?: number, onStdout?: (chunk: Buffer) => void, terminate?: (child: import("node:child_process").ChildProcess) => void }} input
 */
export function runProbe({
  command,
  args,
  stdin,
  timeoutMs = PROBE_TIMEOUT_MS,
  ownPid,
  onStdout,
  terminate = terminateOwnedChild,
}) {
  const { promise, resolve } = Promise.withResolvers();
  const startedAt = performance.now();
  const elapsed = () => Math.round(performance.now() - startedAt);
  const result = {
    spawnedMs: null,
    firstStdoutMs: null,
    firstStderrMs: null,
    exitMs: null,
    closeMs: null,
    exitCode: null,
    signal: null,
    timedOut: false,
    terminated: false,
    stdoutBytes: 0,
    stderrBytes: 0,
  };
  let stdout = "";
  let stderr = "";
  let settled = false;
  let timeoutTimer = null;
  let graceTimer = null;

  const child = spawn(command, args, {
    stdio: "pipe",
    windowsHide: true,
    env: { ...process.env, LC_ALL: "C" },
  });

  const settle = (extra = {}) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutTimer);
    clearTimeout(graceTimer);
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.stdin?.destroy();
    const errorLine = sanitizeErrorLine(stderr);
    resolve({
      ...result,
      ...extra,
      ...(errorLine ? { stderrFirstLine: errorLine } : {}),
      ...(ownPid === undefined ? {} : { matchedOwnPid: outputNamesPid(stdout, ownPid) }),
    });
  };

  child.once("spawn", () => {
    result.spawnedMs = elapsed();
    if (stdin === "closed") child.stdin.end();
  });
  child.once("error", (error) => settle({ spawnErrorCode: error.code ?? "unknown" }));
  child.stdin.on("error", () => {
    // A process that exits early closes its stdin. The exit event reports that outcome.
  });
  child.stdout.on("data", (chunk) => {
    result.firstStdoutMs ??= elapsed();
    result.stdoutBytes += chunk.length;
    if (ownPid !== undefined && stdout.length < MAX_RETAINED_OUTPUT_BYTES) {
      stdout += chunk.toString("utf8");
    }
    onStdout?.(chunk);
  });
  child.stderr.on("data", (chunk) => {
    result.firstStderrMs ??= elapsed();
    result.stderrBytes += chunk.length;
    if (stderr.length < 4_096) stderr += chunk.toString("utf8");
  });
  child.once("exit", (code, signal) => {
    result.exitMs = elapsed();
    result.exitCode = code;
    result.signal = signal;
  });
  child.once("close", () => {
    result.closeMs = elapsed();
    settle();
  });

  timeoutTimer = setTimeout(() => {
    result.timedOut = true;
    if (child.exitCode === null && child.signalCode === null) {
      result.terminated = true;
      terminate(child);
    }
    graceTimer = setTimeout(() => settle({ closeMissing: true }), TERMINATE_GRACE_MS);
  }, timeoutMs);
  return promise;
}
