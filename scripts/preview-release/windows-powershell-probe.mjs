import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { release as osRelease, tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { performance } from "node:perf_hooks";
import { isMainModule } from "../is-main-module.mjs";

// Diagnostic only. Measures how Windows PowerShell behaves on Windows runners, where the terminal
// worker's self-inspection has not returned within its readiness deadline on ARM64, and whether
// inbox JScript with WMI could report the same process identity. It builds and publishes nothing,
// changes no application behavior, and its results are not release qualification.

// A measurement ceiling, long enough to tell a slow command from a hung one. Not an app timeout.
const PROBE_TIMEOUT_MS = 120_000;
const TERMINATE_GRACE_MS = 5_000;
// No new probe starts after this, so the last one and the upload both fit the 30-minute job cap
// even if every probe reaches the ceiling. Results are written after each probe either way.
export const TOTAL_PROBE_BUDGET_MS = 24 * 60_000;
// The most one probe can take: the ceiling, taskkill's own limit and the wait for close.
export const LONGEST_PROBE_MS = PROBE_TIMEOUT_MS + 2 * TERMINATE_GRACE_MS;
// More output than any process table should need. Beyond it a target is reported as not compared.
const MAX_RETAINED_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_LENGTH = 200;

export const COLD_FIRST_ORDERS = ["jscript", "query", "startup"];

/**
 * Command lines for the long-lived comparison targets. They are kept apart because PowerShell 5.1
 * may write redirected output in a legacy code page, so a Unicode mismatch alone must not read as
 * a failure of the ASCII identity marker the worker depends on.
 */
export const SENTINEL_ARGUMENTS = {
  ascii: [
    'quote"d',
    "back\\slash",
    "spa ce",
    "tab\there",
    "a<b>&c",
    "'single'",
    "--marker",
    "id-1",
  ],
  unicode: ["uni-\u00e9-\u2211-\u{1F600}"],
};

const LIMITATIONS = [
  "Standalone Node, not the packaged Electron runtime or the detached terminal worker.",
  "This VM skips the release job's install and build load, which may matter.",
  "first-powershell51-spawn and first-cscript-spawn mean first in this script. Earlier job steps are not proven not to have used them or WMI.",
  "pwsh 7 runs last, so its time is warm evidence and does not show that cold WMI is fast.",
  "Date equality was measured in this runner's time zone only. Daylight saving and other offsets are not exercised on Windows here.",
  "The gone target's pid could be reused before it is queried, so a found result is ambiguous. That pid is only queried, never signalled.",
  "exactStringCompatibility.holds is evidence for this runner and time zone only. Without it, compatibility with existing records is unproven. With it, other time zones and hosts remain unproven.",
  "The cscript host options, including //E:jscript, have not been verified on Windows before this run. A rejected option leaves a blocker, never a pass.",
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
 * The PowerShell baseline: the exact command `inspectWindows` in managed-processes.ts ran before
 * the JScript backend replaced it at 37ad7748c. A contract test pins this text to a frozen copy of
 * that command, so later production changes cannot move the baseline. The worker asked PowerShell
 * about the worker's own pid, its parent, and not PowerShell's $PID. The probe matches that by
 * passing this long-lived Node process's pid.
 * @param {number | string} pid process id, or a template placeholder in that test
 */
export function exactSelfQuery(pid) {
  return [
    `$process = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}';`,
    "if ($process) { $process | Select-Object ProcessId,CommandLine,CreationDate | ConvertTo-Json -Compress }",
  ].join(" ");
}

/** The pre-switch process list command (`listWindowsProcesses`), frozen by the same test. */
export const EXACT_PROCESS_LIST =
  "@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate) | ConvertTo-Json -Compress";

/**
 * The candidate under measurement, run by cscript. ES3 only, with its own JSON writer that escapes
 * every non-ASCII character, so its output depends on neither the script engine nor a code page.
 * Windows 11 24H2 and later may route JScript to JScript9Legacy, so `engine` reports what ran.
 */
export const JSCRIPT_WMI_SOURCE = String.raw`
function quote(value) {
  if (value === null || value === undefined) return "null";
  var text = String(value);
  var out = '"';
  for (var i = 0; i < text.length; i += 1) {
    var code = text.charCodeAt(i);
    if (code === 34 || code === 92) {
      out += "\\" + text.charAt(i);
    } else if (code < 32 || code > 126) {
      var hex = code.toString(16);
      while (hex.length < 4) hex = "0" + hex;
      out += "\\u" + hex;
    } else {
      out += text.charAt(i);
    }
  }
  return out + '"';
}
function query(wql) {
  var service = GetObject("winmgmts:{impersonationLevel=impersonate}!\\\\.\\root\\cimv2");
  var rows = [];
  for (var e = new Enumerator(service.ExecQuery(wql)); !e.atEnd(); e.moveNext()) rows.push(e.item());
  return rows;
}
function run() {
  var named = WScript.Arguments.Named;
  var mode = named.Item("mode");
  if (mode === "engine") {
    return '{"name":' + quote(ScriptEngine()) + ',"major":' + ScriptEngineMajorVersion() +
      ',"minor":' + ScriptEngineMinorVersion() + ',"build":' + ScriptEngineBuildVersion() +
      ',"jsonGlobal":' + (typeof JSON !== "undefined") + "}";
  }
  if (mode === "list") {
    var rows = query("SELECT ProcessId,ParentProcessId,CreationDate FROM Win32_Process");
    var items = [];
    for (var i = 0; i < rows.length; i += 1) {
      items.push('{"ProcessId":' + rows[i].ProcessId + ',"ParentProcessId":' + rows[i].ParentProcessId +
        ',"CreationDate":' + quote(rows[i].CreationDate) + "}");
    }
    return "[" + items.join(",") + "]";
  }
  if (mode === "query") {
    var pid = String(named.Item("pid"));
    if (!/^[0-9]+$/.test(pid)) throw new Error("pid must be numeric");
    var found = query("SELECT ProcessId,CommandLine,CreationDate FROM Win32_Process WHERE ProcessId = " + pid);
    if (found.length === 0) return "";
    return '{"ProcessId":' + found[0].ProcessId + ',"CommandLine":' + quote(found[0].CommandLine) +
      ',"CreationDate":' + quote(found[0].CreationDate) + "}";
  }
  throw new Error("unknown mode");
}
var exitCode = 0;
try {
  WScript.StdOut.Write(run());
} catch (error) {
  WScript.StdErr.WriteLine(String(error.message));
  exitCode = 3;
}
WScript.Quit(exitCode);
`;

/**
 * The ordered probes for one fresh VM. A family's first spawn is the only one that can speak to a
 * cold start, so each order gives that place to a different command. pwsh 7 runs last so it cannot
 * warm the others, and its time is warm evidence only.
 * @param {{ coldFirst: string, targets: { self: number, ascii: number, unicode: number, gone: number } }} input
 */
export function buildProbePlan({ coldFirst, targets }) {
  if (!COLD_FIRST_ORDERS.includes(coldFirst)) {
    throw new Error(`Unknown cold-first order: ${coldFirst}`);
  }
  const powershell = (name, command, extra = {}) => ({
    name,
    shell: "powershell51",
    command,
    ...extra,
  });
  const jscript = (name, mode, target) => ({ name, shell: "jscript", mode, target, compare: name });
  const psQuery = (name, target) =>
    powershell(name, exactSelfQuery(targets[target]), { target, compare: name });

  const psSelf = psQuery("powershell-query-self", "self");
  const psExit = powershell("powershell-exit0", "exit 0");
  const psImport = powershell("powershell-import-cimcmdlets", "Import-Module CimCmdlets; exit 0");
  const psRest = [
    psQuery("powershell-query-ascii", "ascii"),
    psQuery("powershell-query-unicode", "unicode"),
    psQuery("powershell-query-gone", "gone"),
    powershell("powershell-list", EXACT_PROCESS_LIST, { compare: "powershell-list" }),
  ];
  const scripts = [
    jscript("jscript-query-self", "query", "self"),
    jscript("jscript-list", "list"),
    jscript("jscript-engine", "engine"),
    jscript("jscript-query-ascii", "query", "ascii"),
    jscript("jscript-query-unicode", "query", "unicode"),
    jscript("jscript-query-gone", "query", "gone"),
  ];
  const groups = {
    jscript: [...scripts, psSelf, psExit, psImport, ...psRest],
    query: [psSelf, psExit, psImport, ...psRest, ...scripts],
    startup: [psExit, psImport, psSelf, ...psRest, ...scripts],
  };
  const pwsh7 = {
    name: "pwsh7-query-self",
    shell: "pwsh7",
    command: exactSelfQuery(targets.self),
    target: "self",
    compare: "pwsh7-query-self",
  };
  const seen = new Set();
  return [...groups[coldFirst], pwsh7].map((entry) => {
    const firstOfFamily = entry.shell !== "pwsh7" && !seen.has(entry.shell);
    seen.add(entry.shell);
    const label = entry.shell === "jscript" ? "first-cscript-spawn" : "first-powershell51-spawn";
    return Object.assign(entry, {
      stdin: "open",
      warmth: firstOfFamily ? label : "warm",
      targetPid: entry.target ? targets[entry.target] : undefined,
    });
  });
}

/** Masks every digit, so a value's format can be recorded without recording the value. */
export function dateShape(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "string") return typeof value;
  return value.replace(/[0-9]/g, "9").slice(0, 64);
}

/**
 * Converts a CIM_DATETIME string (yyyymmddHHMMSS.mmmmmmsUUU, with UUU the minutes from UTC) to
 * microseconds since the epoch.
 * @returns {number | null} null when the value is not a complete point in time
 */
export function dmtfToEpochMicros(value) {
  const match =
    typeof value === "string"
      ? /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})$/.exec(value)
      : null;
  if (!match) return null;
  const [year, month, day, hour, minute, second, micros] = match.slice(1, 8).map(Number);
  const offsetMinutes = Number(match[9]) * (match[8] === "-" ? -1 : 1);
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes * 60_000;
  return utcMs * 1_000 + micros;
}

/** Reads a date PowerShell printed to epoch milliseconds. The format is what this run observes. */
function powerShellDateToEpochMs(value) {
  if (typeof value !== "string") return null;
  const legacy = /^\/Date\((-?\d+)\)\/$/.exec(value);
  if (legacy) return Number(legacy[1]);
  const micros = dmtfToEpochMicros(value);
  if (micros !== null) return Math.floor(micros / 1_000);
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Compares a PowerShell date with a candidate's, as booleans only. Readers compare stored strings
 * exactly, so `rawEqual` and `exactStringAfterFloor` are the bar for compatibility. The numeric
 * forms show what a conversion would have to do, and one equal sample does not settle it.
 */
export function compareDates(powerShellDate, candidateDate) {
  // Production treats a falsy date as missing, so two missing dates are never an equal date.
  const rawEqual =
    typeof powerShellDate === "string" && powerShellDate !== "" && powerShellDate === candidateDate;
  const reference = powerShellDateToEpochMs(powerShellDate);
  const micros = dmtfToEpochMicros(candidateDate);
  const comparable = reference !== null && micros !== null;
  return {
    rawEqual,
    comparable,
    equalAfterFloorToMs: comparable && Math.floor(micros / 1_000) === reference,
    equalAfterRoundToMs: comparable && Math.round(micros / 1_000) === reference,
    exactStringAfterFloor: comparable && `/Date(${Math.floor(micros / 1_000)})/` === powerShellDate,
  };
}

/** Whether parsed output is a process row at all, rather than other valid JSON. */
function isProcessRow(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Number.isInteger(value.ProcessId)
  );
}

/**
 * Compares one query target against the pid that was asked for. Absent rows stay distinct from a
 * real mismatch, and output that is not a process row counts as absent.
 */
export function compareQueryTarget(powerShellRow, candidateRow, expectedPid) {
  const powerShellPresent = isProcessRow(powerShellRow);
  const candidatePresent = isProcessRow(candidateRow);
  if (!powerShellPresent || !candidatePresent) {
    return { compared: false, powerShellPresent, candidatePresent };
  }
  return {
    compared: true,
    processIdEqual:
      powerShellRow.ProcessId === expectedPid && candidateRow.ProcessId === expectedPid,
    commandLineEqual: powerShellRow.CommandLine === candidateRow.CommandLine,
    commandLineNonEmpty:
      typeof candidateRow.CommandLine === "string" && candidateRow.CommandLine !== "",
    ...compareDates(powerShellRow.CreationDate, candidateRow.CreationDate),
  };
}

/**
 * Compares two process lists taken moments apart, so only pids present in both count. A row with
 * no date on either side is excluded from date evidence, as `listWindowsProcesses` excludes it. A
 * date on one side only is a mismatch. A mismatch can still be a reused pid, so the required live
 * targets are reported separately, including whether each has a date on both sides.
 */
export function compareProcessLists(powerShellRows, candidateRows, requiredPids) {
  if (!Array.isArray(powerShellRows) || !Array.isArray(candidateRows)) {
    return { compared: false };
  }
  const validPowerShell = powerShellRows.filter(isProcessRow);
  const validCandidates = candidateRows.filter(isProcessRow);
  const candidates = new Map(validCandidates.map((row) => [row.ProcessId, row]));
  const powerShellByPid = new Map(validPowerShell.map((row) => [row.ProcessId, row]));
  const counts = {
    malformedRowCount:
      powerShellRows.length -
      validPowerShell.length +
      candidateRows.length -
      validCandidates.length,
    sharedCount: 0,
    bothDatesMissingCount: 0,
    oneSidedDateMissingCount: 0,
    notComparableCount: 0,
    floorMismatchCount: 0,
    roundMismatchCount: 0,
    exactStringMismatchCount: 0,
    parentMismatchCount: 0,
  };
  for (const row of validPowerShell) {
    const candidate = candidates.get(row.ProcessId);
    if (!candidate) continue;
    counts.sharedCount += 1;
    // Production reads a missing parent as 0, so the same absence is not a mismatch here.
    if ((row.ParentProcessId ?? 0) !== (candidate.ParentProcessId ?? 0)) {
      counts.parentMismatchCount += 1;
    }
    if (!row.CreationDate && !candidate.CreationDate) {
      counts.bothDatesMissingCount += 1;
    } else if (!row.CreationDate || !candidate.CreationDate) {
      counts.oneSidedDateMissingCount += 1;
      counts.floorMismatchCount += 1;
      counts.roundMismatchCount += 1;
      counts.exactStringMismatchCount += 1;
    } else {
      const dates = compareDates(row.CreationDate, candidate.CreationDate);
      if (!dates.comparable) counts.notComparableCount += 1;
      if (dates.comparable && !dates.equalAfterFloorToMs) counts.floorMismatchCount += 1;
      if (dates.comparable && !dates.equalAfterRoundToMs) counts.roundMismatchCount += 1;
      if (!dates.rawEqual && !dates.exactStringAfterFloor) counts.exactStringMismatchCount += 1;
    }
  }
  const presentInBoth = (pid) => powerShellByPid.has(pid) && candidates.has(pid);
  return {
    compared: true,
    requiredTargetsInBoth: requiredPids.every(presentInBoth),
    requiredTargetsHaveDates: requiredPids.every(
      (pid) =>
        presentInBoth(pid) &&
        !!powerShellByPid.get(pid).CreationDate &&
        !!candidates.get(pid).CreationDate,
    ),
    ...counts,
  };
}

/** Whether a target's date is the exact string a reader would compare, not just the same time. */
function dateIsExactString(target) {
  return (
    target.compared === true && (target.rawEqual === true || target.exactStringAfterFloor === true)
  );
}

/**
 * The one verdict a reader should use. It holds only with complete evidence: every required target
 * was compared and matched, and the list has real date evidence with no mismatch. A probe that
 * failed, timed out or printed anything unparseable leaves a blocker, never a pass. The Unicode
 * target's command line is excluded because PowerShell 5.1's output encoding can lose it. It holds
 * for this runner and time zone only, so it does not by itself settle compatibility.
 */
export function summarizeCompatibility({ self, sentinelAscii, sentinelUnicode, list }) {
  const identityMatches = (target) =>
    dateIsExactString(target) &&
    target.processIdEqual === true &&
    target.commandLineEqual === true &&
    target.commandLineNonEmpty === true;
  const listMatches =
    list.compared === true &&
    list.requiredTargetsInBoth === true &&
    list.requiredTargetsHaveDates === true &&
    list.malformedRowCount === 0 &&
    list.oneSidedDateMissingCount === 0 &&
    list.notComparableCount === 0 &&
    list.exactStringMismatchCount === 0 &&
    list.parentMismatchCount === 0;
  const checks = {
    self: identityMatches(self),
    ascii: identityMatches(sentinelAscii),
    unicode: dateIsExactString(sentinelUnicode) && sentinelUnicode.processIdEqual === true,
    list: listMatches,
  };
  const blockers = Object.keys(checks).filter((name) => !checks[name]);
  return { holds: blockers.length === 0, blockers };
}

/** Parses retained output as both identity backends do. Empty means not found, distinct from bad JSON. */
function parseOutput(stdout) {
  const trimmed = (stdout ?? "").trim();
  if (trimmed === "") return { empty: true, value: null };
  try {
    return { empty: false, value: JSON.parse(trimmed) };
  } catch {
    return { empty: false, value: null, unparseable: true };
  }
}

/**
 * Reduces the retained outputs of one run to shapes, equality booleans and counts. Nothing that
 * identifies a process, a path or a command line survives this function.
 * @param {Map<string, string>} outputs retained stdout by probe name, held only in memory
 */
export function buildComparison(outputs, targets) {
  const read = (name) => parseOutput(outputs.get(name));
  const pair = (target) =>
    compareQueryTarget(
      read(`powershell-query-${target}`).value,
      read(`jscript-query-${target}`).value,
      targets[target],
    );
  const engine = read("jscript-engine").value;
  const goneFromPowerShell = read("powershell-query-gone");
  const goneFromCandidate = read("jscript-query-gone");
  const self = pair("self");
  const sentinelAscii = pair("ascii");
  const sentinelUnicode = pair("unicode");
  const list = compareProcessLists(read("powershell-list").value, read("jscript-list").value, [
    targets.self,
    targets.ascii,
    targets.unicode,
  ]);
  return {
    exactStringCompatibility: summarizeCompatibility({
      self,
      sentinelAscii,
      sentinelUnicode,
      list,
    }),
    dateShapes: {
      powershell51: dateShape(read("powershell-query-self").value?.CreationDate),
      jscript: dateShape(read("jscript-query-self").value?.CreationDate),
      pwsh7: dateShape(read("pwsh7-query-self").value?.CreationDate),
    },
    jscriptEngine: engine
      ? {
          name: dateShape(String(engine.name)).replace(/9/g, "") || null,
          major: engine.major,
          minor: engine.minor,
          build: engine.build,
          jsonGlobal: engine.jsonGlobal,
        }
      : null,
    self,
    sentinelAscii,
    sentinelUnicode,
    gone: {
      powerShellNotFound: outputs.has("powershell-query-gone") && goneFromPowerShell.empty,
      candidateNotFound: outputs.has("jscript-query-gone") && goneFromCandidate.empty,
    },
    list,
  };
}

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
 * Whether baseline output names this exact process, parsed as the pre-switch inspector parsed it:
 * trimmed first, which also removes a leading byte order mark. The output itself is never retained.
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

/** The exact executable and arguments for one probe. Host options take two slashes on cscript. */
function invocationFor(entry, scriptPath) {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  if (entry.shell === "jscript") {
    const pid = entry.targetPid === undefined ? [] : [`/pid:${entry.targetPid}`];
    return {
      command: win32.join(systemRoot, "System32", "cscript.exe"),
      args: ["//Nologo", "//E:jscript", scriptPath, `/mode:${entry.mode}`, ...pid],
    };
  }
  const args = ["-NoProfile", "-NonInteractive", "-Command", entry.command];
  if (entry.shell === "pwsh7") return { command: "pwsh.exe", args };
  return {
    command: win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args,
  };
}

/** Starts one owned comparison target that stays alive until this script stops it. */
async function startSentinel(extraArguments) {
  const child = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)", "--", ...extraArguments],
    { stdio: "ignore", windowsHide: true },
  );
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  return child;
}

/** Starts a process and waits for it to exit, leaving a pid that should no longer be found. */
async function startAndAwaitExit() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore", windowsHide: true });
  await new Promise((resolve) => child.once("close", resolve));
  return child.pid;
}

/** Replaces the results file whole, so a job timeout still leaves every finished probe readable. */
function writeResults(outputPath, results) {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(`${outputPath}.tmp`, `${JSON.stringify(results, null, 2)}\n`);
  renameSync(`${outputPath}.tmp`, outputPath);
}

/**
 * Runs every probe in order against targets that stay alive throughout. Stdout is retained in
 * memory only to compare, and only timings, shapes, booleans and counts are ever written.
 */
async function measure({ coldFirst, outputPath }) {
  const scriptDirectory = mkdtempSync(join(tmpdir(), "paseo-identity-probe-"));
  const scriptPath = join(scriptDirectory, "wmi-identity.js");
  writeFileSync(scriptPath, JSCRIPT_WMI_SOURCE);
  const ascii = await startSentinel(SENTINEL_ARGUMENTS.ascii);
  const unicode = await startSentinel(SENTINEL_ARGUMENTS.unicode);
  const targets = {
    self: process.pid,
    ascii: ascii.pid,
    unicode: unicode.pid,
    gone: await startAndAwaitExit(),
  };
  const results = {
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
    probes: [],
    comparison: null,
  };
  const outputs = new Map();
  const startedAt = performance.now();
  try {
    for (const entry of buildProbePlan({ coldFirst, targets })) {
      if (performance.now() - startedAt > TOTAL_PROBE_BUDGET_MS) {
        results.probes.push({ name: entry.name, shell: entry.shell, skippedForBudget: true });
        writeResults(outputPath, results);
        continue;
      }
      const chunks = [];
      let retainedBytes = 0;
      const outcome = await runProbe({
        ...invocationFor(entry, scriptPath),
        stdin: entry.stdin,
        ...(entry.targetPid === undefined ? {} : { ownPid: entry.targetPid }),
        onStdout: (chunk) => {
          retainedBytes += chunk.length;
          if (retainedBytes <= MAX_RETAINED_OUTPUT_BYTES) chunks.push(chunk);
        },
      });
      const complete = retainedBytes <= MAX_RETAINED_OUTPUT_BYTES;
      if (entry.compare && complete && !outcome.timedOut && outcome.exitCode === 0) {
        outputs.set(entry.compare, Buffer.concat(chunks).toString("utf8"));
      }
      const summary = {
        name: entry.name,
        shell: entry.shell,
        stdin: entry.stdin,
        warmth: entry.warmth,
        ...outcome,
      };
      results.probes.push(summary);
      results.comparison = buildComparison(outputs, targets);
      writeResults(outputPath, results);
      console.log(JSON.stringify(summary));
    }
  } finally {
    ascii.kill();
    unicode.kill();
    rmSync(scriptDirectory, { recursive: true, force: true });
  }
  return results;
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
    throw new Error("Usage: windows-powershell-probe.mjs <jscript|query|startup> <output.json>");
  }
  await measure({ coldFirst, outputPath });
  // A timed-out child can hold a handle open. The results are written, so end the process here.
  process.exit(0);
}

if (isMainModule(import.meta.url)) {
  await main();
}
