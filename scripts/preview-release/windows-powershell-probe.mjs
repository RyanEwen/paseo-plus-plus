import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { release as osRelease } from "node:os";
import { dirname, win32 } from "node:path";
import { performance } from "node:perf_hooks";
import { isMainModule } from "../is-main-module.mjs";

// Diagnostic only. Measures how Windows PowerShell behaves on the Windows ARM64 runner, where the
// terminal worker's self-inspection has not returned within its readiness deadline. It builds and
// publishes nothing, and its results are not release qualification.

// A measurement ceiling, long enough to tell a slow command from a hung one. Not an app timeout.
const PROBE_TIMEOUT_MS = 60_000;
const TERMINATE_GRACE_MS = 5_000;
const MAX_ERROR_LENGTH = 200;

export const COLD_FIRST_ORDERS = ["query", "startup"];

const LIMITATIONS = [
  "Standalone Node, not the packaged Electron runtime or the detached terminal worker.",
  "This VM skips the release job's install and build load, which may matter.",
  "first-powershell51-spawn means first in this script. Earlier job steps are not proven not to have used Windows PowerShell.",
  "Every later probe is warmed by the ones before it, including any that timed out.",
  "A clean result does not clear PowerShell for the release job's context.",
  "Cleanup after a timeout is best effort: taskkill /T follows parent pids and cannot prove every descendant is owned.",
  "A diagnostic run is not release qualification.",
];

/**
 * Fails closed unless the dispatch asks for this diagnostic and nothing a release would do.
 * @param {{ probe?: string, publish?: string, releaseKind?: string, verifyDaemon?: string }} inputs
 */
export function requireDiagnosticOnly({ probe, publish, releaseKind, verifyDaemon }) {
  if (probe !== "true") {
    throw new Error("The PowerShell probe runs only when windows_powershell_probe is true");
  }
  if (publish !== "false" || releaseKind !== "preview" || verifyDaemon !== "false") {
    throw new Error(
      "windows_powershell_probe cannot be combined with publish, bridge, latest or daemon verification",
    );
  }
}

/**
 * The exact command the inspector runs (`inspectWindows` in managed-processes.ts). A contract test
 * compares this text with that source, so this measurement cannot silently drift from it. The
 * worker asks PowerShell about the worker's own pid, its parent, and not PowerShell's $PID. The
 * probe matches that by passing this long-lived Node process's pid.
 * @param {number | string} pid process id, or a template placeholder in that test
 */
export function exactSelfQuery(pid) {
  return [
    `$process = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}';`,
    "if ($process) { $process | Select-Object ProcessId,CommandLine,CreationDate | ConvertTo-Json -Compress }",
  ].join(" ");
}

/**
 * The ordered probes for one fresh VM. Only the first PowerShell 5.1 spawn can speak to a cold
 * start, so each matrix leg gives that place to a different command. pwsh 7 runs last so it
 * cannot warm the 5.1 results, and it separates WMI from Windows PowerShell.
 * @param {{ coldFirst: string, pid: number }} input
 * @returns {Array<{ name: string, shell: "powershell51" | "pwsh7", command: string, stdin: "open" | "closed", warmth: string, expectsOwnPid: boolean }>}
 */
export function buildProbePlan({ coldFirst, pid }) {
  if (!COLD_FIRST_ORDERS.includes(coldFirst)) {
    throw new Error(`Unknown cold-first order: ${coldFirst}`);
  }
  const query = exactSelfQuery(pid);
  const probe = (name, shell, command, stdin, expectsOwnPid) => ({
    name,
    shell,
    command,
    stdin,
    expectsOwnPid,
  });
  const queryOpen = probe("self-query-stdin-open", "powershell51", query, "open", true);
  const exitOpen = probe("exit0-stdin-open", "powershell51", "exit 0", "open", false);
  const rest = [
    probe("exit0-stdin-closed", "powershell51", "exit 0", "closed", false),
    probe("import-cimcmdlets", "powershell51", "Import-Module CimCmdlets; exit 0", "open", false),
    probe("self-query-stdin-closed", "powershell51", query, "closed", true),
    probe("self-query-explicit-exit", "powershell51", `${query}; exit 0`, "open", true),
  ];
  const ordered =
    coldFirst === "query"
      ? [queryOpen, exitOpen, ...rest, { ...queryOpen, name: "self-query-stdin-open-repeat" }]
      : [exitOpen, ...rest, queryOpen];
  const plan = [...ordered, probe("self-query-pwsh7", "pwsh7", query, "open", true)];
  for (const [index, entry] of plan.entries()) {
    entry.warmth = index === 0 ? "first-powershell51-spawn" : "warm";
  }
  return plan;
}

/** Keeps one short line of an error, without paths, so a failure can be read but discloses nothing. */
export function sanitizeErrorLine(text) {
  const firstLine = text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
  return firstLine
    .replace(/[A-Za-z]:[\\/][^\s"']*/g, "<path>")
    .replace(/\\\\[^\s"']+/g, "<path>")
    .replace(/(^|\s)\/[^\s"']+/g, "$1<path>")
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
 * @param {{ command: string, args: string[], stdin: "open" | "closed", timeoutMs?: number, ownPid?: number, terminate?: (child: import("node:child_process").ChildProcess) => void }} input
 */
export function runProbe({
  command,
  args,
  stdin,
  timeoutMs = PROBE_TIMEOUT_MS,
  ownPid,
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
    if (ownPid !== undefined) stdout += chunk.toString("utf8");
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

function powerShellInvocation(entry) {
  const args = ["-NoProfile", "-NonInteractive", "-Command", entry.command];
  if (entry.shell === "pwsh7") return { command: "pwsh.exe", args };
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  return {
    command: win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args,
  };
}

/** Runs every probe in order and returns only timings, outcomes and runtime identity. */
async function measure({ coldFirst }) {
  const probes = [];
  for (const entry of buildProbePlan({ coldFirst, pid: process.pid })) {
    const outcome = await runProbe({
      ...powerShellInvocation(entry),
      stdin: entry.stdin,
      ...(entry.expectsOwnPid ? { ownPid: process.pid } : {}),
    });
    const summary = {
      name: entry.name,
      shell: entry.shell,
      stdin: entry.stdin,
      warmth: entry.warmth,
      ...outcome,
    };
    probes.push(summary);
    console.log(JSON.stringify(summary));
  }
  return {
    diagnosticOnly: true,
    coldFirst,
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      osRelease: osRelease(),
      image: process.env.ImageOS ?? null,
      imageVersion: process.env.ImageVersion ?? null,
    },
    limitations: LIMITATIONS,
    probes,
  };
}

async function main() {
  requireDiagnosticOnly({
    probe: process.env.PASEO_PROBE_ENABLED,
    publish: process.env.PASEO_PROBE_PUBLISH,
    releaseKind: process.env.PASEO_PROBE_RELEASE_KIND,
    verifyDaemon: process.env.PASEO_PROBE_VERIFY_DAEMON,
  });
  const [coldFirst, outputPath] = process.argv.slice(2);
  if (!coldFirst || !outputPath) {
    throw new Error("Usage: windows-powershell-probe.mjs <query|startup> <output.json>");
  }
  const results = await measure({ coldFirst });
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(results, null, 2)}\n`);
  // A timed-out child can hold a handle open. The results are written, so end the process here.
  process.exit(0);
}

if (isMainModule(import.meta.url)) {
  await main();
}
