import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { jobBlocks } from "../test-support/workflow-jobs.mjs";
import {
  buildComparison,
  buildProbePlan,
  COLD_FIRST_ORDERS,
  compareDates,
  LONGEST_PROBE_MS,
  TOTAL_PROBE_BUDGET_MS,
  compareProcessLists,
  compareQueryTarget,
  dateShape,
  dmtfToEpochMicros,
  EXACT_PROCESS_LIST,
  exactSelfQuery,
  JSCRIPT_WMI_SOURCE,
  runProbe,
  sanitizeErrorLine,
  SENTINEL_ARGUMENTS,
} from "./windows-powershell-probe.mjs";

const repoRoot = new URL("../../", import.meta.url);

test("the PowerShell probe measures the inspector's exact command against its own parent pid", () => {
  const inspector = readFileSync(
    new URL("packages/server/src/server/managed-processes/managed-processes.ts", repoRoot),
    "utf8",
  );
  const [queryPart, outputPart] = exactSelfQuery("${pid}").split("; if ");
  assert.ok(inspector.includes(`\`${queryPart};\``), "query text drifted");
  assert.ok(inspector.includes(`"if ${outputPart}"`), "output text drifted");
  assert.match(inspector, /"-NoProfile",\s+"-NonInteractive",\s+"-Command",\s+command,/);

  const script = readFileSync(
    new URL("scripts/preview-release/windows-powershell-probe.mjs", repoRoot),
    "utf8",
  );
  assert.match(script, /self: process\.pid/);
  const processes = readFileSync(
    new URL("packages/server/src/terminal/terminal-worker-processes.ts", repoRoot),
    "utf8",
  );
  assert.ok(processes.includes(`"${EXACT_PROCESS_LIST}"`), "process list text drifted");
  assert.doesNotMatch(exactSelfQuery(4242), /\$PID/i);
});

test("each identity probe order gives its tool the first spawn, and pwsh 7 runs last", () => {
  const targets = { self: 11, ascii: 22, unicode: 33, gone: 44 };
  const plans = new Map(
    COLD_FIRST_ORDERS.map((coldFirst) => [coldFirst, buildProbePlan({ coldFirst, targets })]),
  );
  assert.equal(plans.get("jscript")[0].name, "jscript-query-self");
  assert.equal(plans.get("jscript")[0].warmth, "first-cscript-spawn");
  assert.equal(plans.get("query")[0].name, "powershell-query-self");
  assert.equal(plans.get("query")[0].warmth, "first-powershell51-spawn");
  assert.equal(plans.get("startup")[0].name, "powershell-exit0");

  for (const plan of plans.values()) {
    assert.equal(plan.at(-1).shell, "pwsh7");
    assert.equal(plan.at(-1).warmth, "warm");
    assert.equal(new Set(plan.map((entry) => entry.name)).size, plan.length);
    assert.equal(plan.filter((entry) => entry.warmth === "first-cscript-spawn").length, 1);
    assert.equal(plan.filter((entry) => entry.warmth === "first-powershell51-spawn").length, 1);
    for (const target of ["self", "ascii", "unicode", "gone"]) {
      assert.equal(
        plan.find((e) => e.name === `jscript-query-${target}`).targetPid,
        targets[target],
      );
      assert.equal(
        plan.find((e) => e.name === `powershell-query-${target}`).targetPid,
        targets[target],
      );
    }
    assert.equal(plan.find((e) => e.name === "powershell-list").command, EXACT_PROCESS_LIST);
    assert.equal(
      plan.find((e) => e.name === "powershell-query-self").command,
      exactSelfQuery(targets.self),
    );
  }
  assert.throws(() => buildProbePlan({ coldFirst: "other", targets }));
});

/** Runs the real JScript source in a sandbox with fake COM objects. This is not Windows or cscript. */
function runJscript({ mode, pid, rows = [] }) {
  let stdout = "";
  let stderr = "";
  let exitCode = null;
  const wql = [];
  class Enumerator {
    constructor(items) {
      this.items = items;
      this.index = 0;
    }
    atEnd() {
      return this.index >= this.items.length;
    }
    moveNext() {
      this.index += 1;
    }
    item() {
      return this.items[this.index];
    }
  }
  const context = {
    Enumerator,
    GetObject: (moniker) => {
      assert.match(moniker, /^winmgmts:.*\\\\\.\\root\\cimv2$/);
      return {
        ExecQuery: (query) => {
          wql.push(query);
          return rows;
        },
      };
    },
    ScriptEngine: () => "JScript",
    ScriptEngineMajorVersion: () => 5,
    ScriptEngineMinorVersion: () => 8,
    ScriptEngineBuildVersion: () => 1,
    WScript: {
      Arguments: { Named: { Item: (name) => ({ mode, pid })[name] } },
      StdOut: {
        Write: (text) => {
          stdout += text;
        },
      },
      StdErr: {
        WriteLine: (text) => {
          stderr += text;
        },
      },
      Quit: (code) => {
        exitCode = code;
      },
    },
  };
  runInNewContext(JSCRIPT_WMI_SOURCE, context);
  return { stdout, stderr, exitCode, wql };
}

test("the JScript candidate writes valid JSON for serialization edge cases and stays ES3", () => {
  // A sandbox run of the real source with fake COM objects, not a claim about cscript or WMI.
  const commandLine = [
    'node "quote\\"d" back\\slash spa ce\ttab',
    "line\r\nbreak <>&' \u0001 \u00e9 \u2211 \u{1F600}",
  ].join(" ");
  const date = "20261105031555.123456+000";
  const query = runJscript({
    mode: "query",
    pid: 4242,
    rows: [{ ProcessId: 4242, CommandLine: commandLine, CreationDate: date }],
  });
  assert.equal(query.exitCode, 0, query.stderr);
  assert.deepEqual(JSON.parse(query.stdout), {
    ProcessId: 4242,
    CommandLine: commandLine,
    CreationDate: date,
  });
  // Non-ASCII leaves as escapes, so the output cannot depend on a code page.
  assert.match(query.stdout, /^[\x20-\x7e]+$/);
  assert.match(query.wql[0], /WHERE ProcessId = 4242$/);

  const nullLine = runJscript({
    mode: "query",
    pid: 7,
    rows: [{ ProcessId: 7, CommandLine: null, CreationDate: null }],
  });
  assert.deepEqual(JSON.parse(nullLine.stdout), {
    ProcessId: 7,
    CommandLine: null,
    CreationDate: null,
  });

  const gone = runJscript({ mode: "query", pid: 9, rows: [] });
  assert.equal(gone.stdout, "");
  assert.equal(gone.exitCode, 0);

  const list = runJscript({
    mode: "list",
    rows: [
      { ProcessId: 1, ParentProcessId: 0, CreationDate: date },
      { ProcessId: 2, ParentProcessId: 1, CreationDate: null },
    ],
  });
  assert.deepEqual(JSON.parse(list.stdout), [
    { ProcessId: 1, ParentProcessId: 0, CreationDate: date },
    { ProcessId: 2, ParentProcessId: 1, CreationDate: null },
  ]);
  assert.equal(JSON.parse(runJscript({ mode: "list", rows: [] }).stdout).length, 0);

  const engine = JSON.parse(runJscript({ mode: "engine" }).stdout);
  assert.equal(engine.name, "JScript");
  assert.equal(typeof engine.jsonGlobal, "boolean");

  const invalid = runJscript({ mode: "query", pid: "1 OR 1=1" });
  assert.equal(invalid.exitCode, 3);
  assert.equal(invalid.wql.length, 0);
  assert.equal(invalid.stdout, "");

  // Whatever engine cscript routes to, this source relies only on ES3 syntax and its own writer.
  assert.doesNotMatch(JSCRIPT_WMI_SOURCE, /\b(?:let|const|class)\s|=>|`|JSON\.(?:stringify|parse)/);
});

test("identity dates convert from CIM_DATETIME and compare without exposing values", () => {
  const utc = Date.UTC(2026, 10, 5, 3, 15, 55);
  assert.equal(dmtfToEpochMicros("20261105031555.123456+000"), utc * 1_000 + 123_456);
  // The offset is minutes from UTC: a local time ahead of UTC is earlier in UTC.
  assert.equal(dmtfToEpochMicros("20261105031555.000000+060"), (utc - 3_600_000) * 1_000);
  assert.equal(dmtfToEpochMicros("20261105031555.000000-300"), (utc + 18_000_000) * 1_000);
  for (const invalid of ["", null, 5, "20261105031555.******+***", "2026-11-05"]) {
    assert.equal(dmtfToEpochMicros(invalid), null);
  }

  const dmtf = "20261105031555.123956+000";
  const floor = compareDates(`/Date(${utc + 123})/`, dmtf);
  assert.deepEqual(floor, {
    rawEqual: false,
    comparable: true,
    equalAfterFloorToMs: true,
    equalAfterRoundToMs: false,
    exactStringAfterFloor: true,
  });
  // The same instant in two offsets, as a daylight saving change would report it. Conversion
  // handles the arithmetic. Raw strings still differ, and that evidence stays separate.
  const eastern = "20261105001555.123000-180";
  const atlantic = "20261105031555.123000+000";
  assert.equal(dmtfToEpochMicros(eastern), dmtfToEpochMicros(atlantic));
  assert.equal(compareDates(eastern, atlantic).rawEqual, false);
  assert.equal(compareDates(eastern, atlantic).equalAfterFloorToMs, true);
  // A numerically equal date in another format is not string compatible.
  const iso = compareDates(new Date(utc + 123).toISOString(), dmtf);
  assert.equal(iso.equalAfterFloorToMs, true);
  assert.equal(iso.exactStringAfterFloor, false);
  for (const [powerShell, candidate] of [
    [null, dmtf],
    [undefined, dmtf],
    [`/Date(${utc})/`, null],
    [`/Date(${utc})/`, undefined],
    [`/Date(${utc})/`, "20261105031555.******+***"],
  ]) {
    assert.deepEqual(compareDates(powerShell, candidate), {
      rawEqual: false,
      comparable: false,
      equalAfterFloorToMs: false,
      equalAfterRoundToMs: false,
      exactStringAfterFloor: false,
    });
  }
  const round = compareDates(`/Date(${utc + 124})/`, dmtf);
  assert.equal(round.equalAfterFloorToMs, false);
  assert.equal(round.equalAfterRoundToMs, true);
  assert.equal(compareDates(dmtf, dmtf).rawEqual, true);
  assert.equal(compareDates(`/Date(${utc + 500})/`, dmtf).equalAfterFloorToMs, false);
  assert.equal(compareDates("unrecognized", dmtf).comparable, false);
  assert.equal(compareDates(null, null).rawEqual, false);

  assert.equal(dateShape(`/Date(${utc})/`), "/Date(9999999999999)/");
  assert.equal(dateShape(dmtf), "99999999999999.999999+999");
  assert.equal(dateShape(null), "null");
  assert.equal(dateShape({ value: 1 }), "object");
});

test("identity comparison keeps absent, mismatched and reused-pid results distinct", () => {
  const date = "20261105031555.123456+000";
  const row = { ProcessId: 5, CommandLine: "cmd --marker id-1", CreationDate: date };
  assert.deepEqual(compareQueryTarget(null, row, 5), {
    compared: false,
    powerShellPresent: false,
    candidatePresent: true,
  });
  const equal = compareQueryTarget(row, { ...row }, 5);
  assert.equal(equal.compared, true);
  assert.equal(equal.processIdEqual, true);
  assert.equal(equal.commandLineEqual, true);
  assert.equal(equal.rawEqual, true);
  assert.equal(
    compareQueryTarget(row, { ...row, CommandLine: "other" }, 5).commandLineEqual,
    false,
  );
  assert.equal(compareQueryTarget(row, { ...row, ProcessId: 6 }, 5).processIdEqual, false);

  const list = (entries) =>
    entries.map(([ProcessId, ParentProcessId]) => ({
      ProcessId,
      ParentProcessId,
      CreationDate: date,
    }));
  assert.deepEqual(
    compareProcessLists(
      list([
        [1, 0],
        [2, 1],
        [3, 1],
      ]),
      list([
        [2, 1],
        [3, 9],
        [4, 1],
      ]),
      [2],
    ),
    {
      compared: true,
      requiredTargetsInBoth: true,
      requiredTargetsHaveDates: true,
      malformedRowCount: 0,
      sharedCount: 2,
      bothDatesMissingCount: 0,
      oneSidedDateMissingCount: 0,
      notComparableCount: 0,
      floorMismatchCount: 0,
      roundMismatchCount: 0,
      exactStringMismatchCount: 0,
      parentMismatchCount: 1,
    },
  );
  assert.equal(
    compareProcessLists(list([[1, 0]]), list([[1, 0]]), [2]).requiredTargetsInBoth,
    false,
  );
  assert.deepEqual(compareProcessLists(null, [], []), { compared: false });
});

test("identity list comparison mirrors production's missing-date rule without false counts", () => {
  const date = "20261105031555.123456+000";
  const reported = "/Date(1793848555123)/";
  const row = (ProcessId, CreationDate) => ({ ProcessId, ParentProcessId: 1, CreationDate });

  // Production skips a row whose date is falsy, so absent on both sides is not date evidence.
  for (const missing of [null, undefined, ""]) {
    const both = compareProcessLists(
      [row(4, reported), row(5, missing)],
      [row(4, date), row(5, missing)],
      [4],
    );
    assert.equal(both.bothDatesMissingCount, 1, String(missing));
    assert.equal(both.exactStringMismatchCount, 0, String(missing));
    assert.equal(both.notComparableCount, 0, String(missing));
    assert.equal(both.floorMismatchCount, 0, String(missing));
    assert.equal(both.oneSidedDateMissingCount, 0, String(missing));
    assert.equal(both.requiredTargetsHaveDates, true, String(missing));

    // Missing on one side is a mismatch whichever side it is.
    for (const [powerShell, candidate] of [
      [missing, date],
      [reported, missing],
    ]) {
      const oneSided = compareProcessLists([row(5, powerShell)], [row(5, candidate)], []);
      assert.equal(oneSided.oneSidedDateMissingCount, 1, String(missing));
      assert.equal(oneSided.exactStringMismatchCount, 1, String(missing));
      assert.equal(oneSided.floorMismatchCount, 1, String(missing));
      assert.equal(oneSided.bothDatesMissingCount, 0, String(missing));
    }

    // A required live target with no date can never read as compatible.
    const required = compareProcessLists(
      [row(4, reported), row(5, missing)],
      [row(4, date), row(5, missing)],
      [5],
    );
    assert.equal(required.requiredTargetsInBoth, true, String(missing));
    assert.equal(required.requiredTargetsHaveDates, false, String(missing));

    // Two missing dates are not an equal date.
    assert.equal(compareDates(missing, missing).rawEqual, false, String(missing));
  }

  // Non-row entries are reported, never treated as processes.
  const malformed = compareProcessLists([row(4, reported), null, 7], [row(4, date), { a: 1 }], [4]);
  assert.equal(malformed.malformedRowCount, 3);
  assert.equal(malformed.sharedCount, 1);
});

test("identity compatibility holds only with complete, exact evidence on every required target", () => {
  const targets = { self: 11, ascii: 22, unicode: 33, gone: 44 };
  const candidateDate = "20261105031555.123456+000";
  const reportedDate = `/Date(${Math.floor(dmtfToEpochMicros(candidateDate) / 1_000)})/`;
  const queryRow = (pid, CreationDate) => ({
    ProcessId: pid,
    CommandLine: `node --marker ${pid}`,
    CreationDate,
  });
  const listRow = (pid, CreationDate) => ({ ProcessId: pid, ParentProcessId: 1, CreationDate });
  const pids = [targets.self, targets.ascii, targets.unicode];
  const complete = () =>
    new Map([
      ["powershell-query-self", JSON.stringify(queryRow(11, reportedDate))],
      ["jscript-query-self", JSON.stringify(queryRow(11, candidateDate))],
      ["powershell-query-ascii", JSON.stringify(queryRow(22, reportedDate))],
      ["jscript-query-ascii", JSON.stringify(queryRow(22, candidateDate))],
      ["powershell-query-unicode", JSON.stringify(queryRow(33, reportedDate))],
      ["jscript-query-unicode", JSON.stringify(queryRow(33, candidateDate))],
      ["powershell-list", JSON.stringify(pids.map((pid) => listRow(pid, reportedDate)))],
      ["jscript-list", JSON.stringify(pids.map((pid) => listRow(pid, candidateDate)))],
    ]);
  const verdict = (outputs) => buildComparison(outputs, targets).exactStringCompatibility;

  assert.deepEqual(verdict(complete()), { holds: true, blockers: [] });

  // A Unicode command line may be lost to a code page. Its date still has to match.
  const lossyUnicode = complete();
  lossyUnicode.set(
    "powershell-query-unicode",
    JSON.stringify({ ...queryRow(33, reportedDate), CommandLine: "node ???" }),
  );
  assert.equal(verdict(lossyUnicode).holds, true);

  const blockedBy = (name, change) => {
    const outputs = complete();
    change(outputs);
    const result = verdict(outputs);
    assert.equal(result.holds, false, name);
    assert.ok(result.blockers.includes(name), `${name} in ${result.blockers}`);
  };

  // A malformed invocation leaves no comparable output, and can never read as a pass.
  blockedBy("self", (outputs) => outputs.delete("jscript-query-self"));
  blockedBy("self", (outputs) =>
    outputs.set(
      "jscript-query-self",
      `Microsoft (R) Windows Script Host\n${outputs.get("jscript-query-self")}`,
    ),
  );
  blockedBy("self", (outputs) => outputs.set("jscript-query-self", ""));
  blockedBy("self", (outputs) => outputs.set("jscript-query-self", "7"));
  blockedBy("self", (outputs) => {
    outputs.set("powershell-query-self", '"text"');
    outputs.set("jscript-query-self", '"text"');
  });
  blockedBy("list", (outputs) => outputs.delete("jscript-list"));
  blockedBy("list", (outputs) => outputs.set("jscript-list", "[]"));

  // Wrong process, wrong command line, wrong or missing date.
  blockedBy("self", (outputs) =>
    outputs.set("jscript-query-self", JSON.stringify(queryRow(99, candidateDate))),
  );
  blockedBy("ascii", (outputs) =>
    outputs.set(
      "jscript-query-ascii",
      JSON.stringify({ ...queryRow(22, candidateDate), CommandLine: "other" }),
    ),
  );
  blockedBy("self", (outputs) => {
    outputs.set(
      "powershell-query-self",
      JSON.stringify({ ...queryRow(11, null), CommandLine: "" }),
    );
    outputs.set("jscript-query-self", JSON.stringify({ ...queryRow(11, null), CommandLine: "" }));
  });
  blockedBy("unicode", (outputs) =>
    outputs.set("jscript-query-unicode", JSON.stringify(queryRow(33, "20261105031555.999999+000"))),
  );
  blockedBy("list", (outputs) =>
    outputs.set(
      "jscript-list",
      JSON.stringify([listRow(11, null), listRow(22, candidateDate), listRow(33, candidateDate)]),
    ),
  );
  blockedBy("list", (outputs) =>
    outputs.set(
      "jscript-list",
      JSON.stringify([
        { ...listRow(11, candidateDate), ParentProcessId: 9 },
        listRow(22, candidateDate),
        listRow(33, candidateDate),
      ]),
    ),
  );
  // Numerically equal, but not the string a reader compares.
  blockedBy("self", (outputs) =>
    outputs.set(
      "powershell-query-self",
      JSON.stringify(
        queryRow(11, new Date(dmtfToEpochMicros(candidateDate) / 1_000).toISOString()),
      ),
    ),
  );
  assert.deepEqual(verdict(new Map()).holds, false);
});

test("the identity comparison written to results holds no process values", () => {
  const secretLine = "C:\\Users\\someone\\private.exe --token hunter2";
  const row = {
    ProcessId: 11,
    CommandLine: secretLine,
    CreationDate: "20261105031555.123456+000",
  };
  const outputs = new Map([
    ["jscript-query-self", JSON.stringify(row)],
    ["powershell-query-self", JSON.stringify({ ...row, CreationDate: "/Date(1793848555123)/" })],
    ["jscript-query-gone", ""],
    ["powershell-query-gone", ""],
    [
      "jscript-engine",
      JSON.stringify({ name: "JScript", major: 5, minor: 8, build: 1, jsonGlobal: false }),
    ],
    ["jscript-list", JSON.stringify([row])],
    ["powershell-list", JSON.stringify([{ ...row, CreationDate: "/Date(1793848555123)/" }])],
    ["jscript-query-ascii", "not json"],
  ]);
  const comparison = buildComparison(outputs, { self: 11, ascii: 22, unicode: 33, gone: 44 });
  assert.equal(comparison.dateShapes.powershell51, "/Date(9999999999999)/");
  assert.equal(comparison.dateShapes.jscript, "99999999999999.999999+999");
  assert.equal(comparison.self.commandLineEqual, true);
  assert.equal(comparison.gone.powerShellNotFound, true);
  assert.equal(comparison.gone.candidateNotFound, true);
  assert.equal(comparison.sentinelAscii.compared, false);
  assert.equal(comparison.jscriptEngine.name, "JScript");
  const written = JSON.stringify(comparison);
  for (const value of ["private", "hunter2", "someone", "1793848555123", "20261105"]) {
    assert.ok(!written.includes(value), value);
  }
  // A probe that never ran is not the same as a process that was not found.
  assert.equal(
    buildComparison(new Map(), { self: 1, ascii: 2, unicode: 3, gone: 4 }).gone.candidateNotFound,
    false,
  );
});

test("the identity probe's worst case fits its job cap, leaving time to upload", () => {
  const source = readFileSync(new URL(".github/workflows/preview-release.yml", repoRoot), "utf8");
  const probe = jobBlocks(source).get("windows-powershell-probe").join("\n");
  const capMinutes = Number(/timeout-minutes: (\d+)/.exec(probe)[1]);
  // A probe may start just inside the budget and then run to its full length.
  const worstCaseMinutes = (TOTAL_PROBE_BUDGET_MS + LONGEST_PROBE_MS) / 60_000;
  assert.ok(worstCaseMinutes + 3 <= capMinutes, `${worstCaseMinutes} of ${capMinutes} minutes`);
  // Upload runs even after a failure or cancellation, so partial results survive.
  assert.match(probe, /upload-artifact@[^\n]*\n\s+if: always\(\)/);
  const script = readFileSync(
    new URL("scripts/preview-release/windows-powershell-probe.mjs", repoRoot),
    "utf8",
  );
  assert.match(script, /skippedForBudget: true/);
  assert.match(script, /renameSync\(`\$\{outputPath\}\.tmp`, outputPath\)/);
});

test("the identity probe sentinels separate the ASCII marker from Unicode", () => {
  const isAscii = (value) => [...value].every((character) => character.codePointAt(0) < 128);
  assert.ok(SENTINEL_ARGUMENTS.ascii.every(isAscii));
  assert.ok(SENTINEL_ARGUMENTS.ascii.includes("--marker"));
  assert.ok(!SENTINEL_ARGUMENTS.unicode.every(isAscii));
});

test("the PowerShell probe sanitizes errors down to one short line without paths", () => {
  assert.equal(
    sanitizeErrorLine("\r\nCannot load C:\\Users\\runner\\secret\\mod.psm1 here\r\nsecond line"),
    "Cannot load <path> here",
  );
  assert.equal(
    sanitizeErrorLine("failed at \\\\host\\share\\x and /home/me/y"),
    "failed at <path> and <path>",
  );
  assert.equal(sanitizeErrorLine("x".repeat(500)).length, 200);
  assert.equal(
    sanitizeErrorLine("bad date 20261105031555 for pid 4242"),
    "bad date <number> for pid 4242",
  );
  assert.equal(sanitizeErrorLine(""), "");
});

test("a PowerShell probe times a real process and retains no output", async () => {
  const script =
    "process.stderr.write('bad /secret/path\\n'); process.stdout.write(JSON.stringify({ ProcessId: 4242, CommandLine: 'private' }));";
  const result = await runProbe({
    command: process.execPath,
    args: ["-e", script],
    stdin: "closed",
    ownPid: 4242,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.terminated, false);
  assert.equal(result.matchedOwnPid, true);
  assert.ok(result.firstStdoutMs !== null && result.exitMs !== null && result.closeMs !== null);
  assert.ok(result.spawnedMs <= result.closeMs);
  assert.ok(result.stdoutBytes > 0);
  assert.equal(result.stderrFirstLine, "bad <path>");
  assert.doesNotMatch(JSON.stringify(result), /private|secret/);

  const missing = await runProbe({ command: "/nonexistent/probe", args: [], stdin: "open" });
  assert.equal(missing.spawnErrorCode, "ENOENT");
});

test("a PowerShell probe matches its own pid through surrounding whitespace, as the inspector parses", async () => {
  // A real child writes these bytes. This covers the parsing only, and is not PowerShell output.
  const writes = (pid) =>
    `process.stdout.write("\\uFEFF \\r\\n" + JSON.stringify({ ProcessId: ${pid} }) + " \\r\\n");`;
  const probe = (pid) =>
    runProbe({
      command: process.execPath,
      args: ["-e", writes(pid)],
      stdin: "closed",
      ownPid: 4242,
    });

  assert.equal((await probe(4242)).matchedOwnPid, true);
  assert.equal((await probe(4243)).matchedOwnPid, false);
  const inspector = readFileSync(
    new URL("packages/server/src/server/managed-processes/managed-processes.ts", repoRoot),
    "utf8",
  );
  assert.match(inspector, /const trimmed = stdout\.trim\(\);[\s\S]*JSON\.parse\(trimmed\)/);
});

test("a PowerShell probe stops only its own still-running child at the ceiling", async () => {
  // Exits only when stdin ends, so the two stdin modes must produce different outcomes.
  const readsStdin = "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));";
  const closed = await runProbe({
    command: process.execPath,
    args: ["-e", readsStdin],
    stdin: "closed",
    timeoutMs: 10_000,
  });
  assert.equal(closed.timedOut, false);
  assert.equal(closed.terminated, false);
  assert.equal(closed.exitCode, 0);

  const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  try {
    const terminated = [];
    const open = await runProbe({
      command: process.execPath,
      args: ["-e", readsStdin],
      stdin: "open",
      timeoutMs: 500,
      terminate: (child) => {
        terminated.push(child.pid);
        child.kill("SIGKILL");
      },
    });
    assert.equal(open.timedOut, true);
    assert.equal(open.terminated, true);
    assert.equal(open.signal, "SIGKILL");
    assert.equal(terminated.length, 1);
    assert.notEqual(terminated[0], bystander.pid);
    assert.equal(bystander.exitCode, null);
    assert.doesNotThrow(() => process.kill(bystander.pid, 0));
  } finally {
    bystander.kill("SIGKILL");
  }
});

test("a PowerShell probe never signals a child that already exited but left its pipes held", async () => {
  // The child exits at once while a detached grandchild keeps the stdout pipe open.
  const holdsPipes = `
    const { spawn } = require("node:child_process");
    const held = spawn(process.execPath, ["-e", "setTimeout(() => {}, 4000)"], {
      detached: true,
      stdio: "inherit",
    });
    held.unref();
    process.exit(0);
  `;
  const terminated = [];
  const result = await runProbe({
    command: process.execPath,
    args: ["-e", holdsPipes],
    stdin: "closed",
    timeoutMs: 1_000,
    terminate: (child) => terminated.push(child.pid),
  });
  assert.deepEqual(terminated, []);
  assert.equal(result.exitCode, 0);
  assert.notEqual(result.exitMs, null);
  assert.equal(result.timedOut, true);
  assert.equal(result.terminated, false);
});

test("the PowerShell probe command refuses without its guard and writes only allowed fields", () => {
  const script = new URL("scripts/preview-release/windows-powershell-probe.mjs", repoRoot).pathname;
  const directory = mkdtempSync(join(tmpdir(), "powershell-probe-"));
  try {
    const output = join(directory, "results.json");
    const refused = spawnSync(process.execPath, [script, "query", output], {
      encoding: "utf8",
      env: { ...process.env, PASEO_PROBE_ENABLED: "true", PASEO_PROBE_PUBLISH: "true" },
    });
    assert.notEqual(refused.status, 0);

    // No PowerShell exists here, so every probe reports a spawn error. Nothing here runs on Windows.
    const completed = spawnSync(process.execPath, [script, "query", output], {
      encoding: "utf8",
      env: {
        ...process.env,
        PASEO_PROBE_ENABLED: "true",
        PASEO_PROBE_PUBLISH: "false",
        PASEO_PROBE_RELEASE_KIND: "preview",
        PASEO_PROBE_VERIFY_DAEMON: "false",
        PROBE_TEST_SENTINEL: "sentinel-value",
      },
    });
    assert.equal(completed.status, 0, completed.stderr);
    const text = readFileSync(output, "utf8");
    const results = JSON.parse(text);
    assert.equal(results.diagnosticOnly, true);
    assert.deepEqual(Object.keys(results.runtime), [
      "node",
      "platform",
      "arch",
      "osRelease",
      "image",
      "imageVersion",
    ]);
    assert.equal(
      results.probes.length,
      buildProbePlan({ coldFirst: "query", targets: { self: 1, ascii: 2, unicode: 3, gone: 4 } })
        .length,
    );
    assert.equal(results.comparison.self.compared, false);
    for (const printed of [text, completed.stdout]) {
      assert.doesNotMatch(
        printed,
        /sentinel-value|Get-CimInstance|ConvertTo-Json|powershell\.exe|cscript\.exe|winmgmts|--marker/,
      );
      assert.ok(!printed.includes(directory));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
