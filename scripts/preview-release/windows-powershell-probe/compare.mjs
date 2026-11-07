// Reduces retained probe output to shapes, equality booleans and counts, never values.

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

/** Parses retained output as the inspector does. Empty means not found, and is distinct from bad JSON. */
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
          // Keep the engine name's letters only; its digits could carry a build identity.
          name: String(engine.name).slice(0, 64).replace(/[0-9]/g, "") || null,
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
