import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import {
  createManagedProcessRegistry,
  createPidTarget,
  createSystemManagedProcessTable,
  type ManagedProcessCommandRunner,
  type ManagedProcessInspection,
  type ManagedProcessSnapshot,
  type ManagedProcessTable,
} from "./managed-processes.js";
import {
  cimDateTimeToRecordedStartedAt,
  listWindowsProcessTable,
  readWindowsProcessIdentity,
  resolveWindowsProcessIdentityScriptPath,
  WINDOWS_PROCESS_IDENTITY_SCRIPT_NAME,
  WindowsProcessIdentityError,
  windowsScriptHostPath,
} from "./windows-process-identity.js";
import { createTerminalWorkerProcessInspector } from "../../terminal/terminal-worker-processes.js";
import { spawnProcess } from "../../utils/spawn.js";
import {
  terminateWithTreeKill,
  type ProcessTerminator,
  type TreeKillTarget,
} from "../../utils/tree-kill.js";

let tempHome: string | null = null;

afterEach(async () => {
  if (tempHome) {
    await rm(tempHome, { recursive: true, force: true });
    tempHome = null;
  }
});

describe("managed process registry", () => {
  test("reaps a validated leftover helper process and deletes its record", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const processTable = new FakeProcessTable([
      {
        pid: 4101,
        commandLine: "opencode serve --port 4101",
        startedAt: "process-start-token",
      },
    ]);
    const terminator = new FakeProcessTerminator();
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable,
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    await registry.record({
      owner: { provider: "opencode", kind: "helper-server" },
      pid: 4101,
      command: "opencode",
      args: ["serve", "--port", "4101"],
      metadata: { port: 4101 },
    });

    const restartedRegistry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable,
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    const result = await restartedRegistry.reapStale();

    expect(result).toEqual({
      checked: 1,
      dead: 0,
      mismatched: 0,
      removed: 1,
      terminated: 1,
      errors: [],
    });
    expect(terminator.terminatedPids).toEqual([4101]);
    expect(await restartedRegistry.list()).toEqual([]);
  });

  test("deletes a dead helper process record without terminating a PID", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const processTable = new FakeProcessTable([
      {
        pid: 4102,
        commandLine: "opencode serve --port 4102",
        startedAt: "process-start-token",
      },
    ]);
    const terminator = new FakeProcessTerminator();
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable,
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    await registry.record({
      owner: { provider: "opencode", kind: "helper-server" },
      pid: 4102,
      command: "opencode",
      args: ["serve", "--port", "4102"],
      metadata: { port: 4102 },
    });

    const restartedRegistry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([]),
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    const result = await restartedRegistry.reapStale();

    expect(result).toEqual({
      checked: 1,
      dead: 1,
      mismatched: 0,
      removed: 1,
      terminated: 0,
      errors: [],
    });
    expect(terminator.terminatedPids).toEqual([]);
    expect(await restartedRegistry.list()).toEqual([]);
  });

  test("removes a reused PID record without terminating the new process", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const terminator = new FakeProcessTerminator();
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([
        {
          pid: 4103,
          commandLine: "opencode serve --port 4103",
          startedAt: "original-start-token",
        },
      ]),
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    await registry.record({
      owner: { provider: "opencode", kind: "helper-server" },
      pid: 4103,
      command: "opencode",
      args: ["serve", "--port", "4103"],
      metadata: { port: 4103 },
    });

    const restartedRegistry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([
        {
          pid: 4103,
          commandLine: "opencode serve --port 4103",
          startedAt: "new-process-start-token",
        },
      ]),
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    const result = await restartedRegistry.reapStale();

    expect(result).toEqual({
      checked: 1,
      dead: 0,
      mismatched: 1,
      removed: 1,
      terminated: 0,
      errors: [],
    });
    expect(terminator.terminatedPids).toEqual([]);
    expect(await restartedRegistry.list()).toEqual([]);
  });

  test("keeps a helper record when inspection fails instead of orphaning a live process", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const terminator = new FakeProcessTerminator();
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([
        { pid: 4104, commandLine: "opencode serve --port 4104", startedAt: "process-start-token" },
      ]),
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    await registry.record({
      owner: { provider: "opencode", kind: "helper-server" },
      pid: 4104,
      command: "opencode",
      args: ["serve", "--port", "4104"],
      metadata: { port: 4104 },
    });

    const restartedRegistry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([], [4104]),
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    const result = await restartedRegistry.reapStale();

    expect(result).toMatchObject({
      checked: 1,
      dead: 0,
      mismatched: 0,
      removed: 0,
      terminated: 0,
    });
    expect(result.errors).toEqual([{ id: expect.any(String), message: "inspection failed" }]);
    expect(terminator.terminatedPids).toEqual([]);
    expect(await restartedRegistry.list()).toHaveLength(1);
  });

  test("does not terminate a reused PID whose command line only mentions the tokens", async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-managed-processes-"));
    const terminator = new FakeProcessTerminator();
    const registry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([], [4105]),
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    await registry.record({
      owner: { provider: "opencode", kind: "helper-server" },
      pid: 4105,
      command: "opencode",
      args: ["serve", "--port", "4105"],
      metadata: { port: 4105 },
    });

    const restartedRegistry = createManagedProcessRegistry({
      paseoHome: tempHome,
      processTable: new FakeProcessTable([
        {
          pid: 4105,
          commandLine: "node /tmp/serve.js --port 4105 # opencode helper",
          startedAt: null,
        },
      ]),
      terminateProcess: terminator.terminate,
      logger: createTestLogger(),
    });
    const result = await restartedRegistry.reapStale();

    expect(result).toEqual({
      checked: 1,
      dead: 0,
      mismatched: 1,
      removed: 1,
      terminated: 0,
      errors: [],
    });
    expect(terminator.terminatedPids).toEqual([]);
    expect(await restartedRegistry.list()).toEqual([]);
  });
});

describe("managed process termination", () => {
  test("stops as soon as a terminated process exits instead of escalating to SIGKILL", async () => {
    const child = spawnProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const pid = child.pid;
    if (!pid) {
      throw new Error("Failed to spawn test process");
    }

    let forced = false;
    const result = await terminateWithTreeKill(createPidTarget(pid), {
      gracefulTimeoutMs: 2_000,
      forceTimeoutMs: 1_000,
      onForceSignal: () => {
        forced = true;
      },
    });

    expect(result).toBe("terminated");
    expect(forced).toBe(false);
  });
});

describe("system managed process table", () => {
  test("reads POSIX process identity from ps", async () => {
    const commandRunner = new FakeCommandRunner([
      {
        stdout: "Sat Jun 20 10:30:40 2026 opencode serve --port 4101\n",
        stderr: "",
      },
    ]);
    const processTable = createSystemManagedProcessTable({
      platform: "darwin",
      commandRunner,
    });

    const inspection = await processTable.inspect(4101);

    expect(inspection).toEqual({
      status: "alive",
      snapshot: {
        pid: 4101,
        commandLine: "opencode serve --port 4101",
        startedAt: "Sat Jun 20 10:30:40 2026",
      },
    });
    expect(commandRunner.commands).toEqual([
      {
        command: "ps",
        args: ["-ww", "-p", "4101", "-o", "lstart=", "-o", "command="],
      },
    ]);
  });

  test("reads Windows process identity through the identity script, in the stored date format", async () => {
    const commandRunner = new FakeCommandRunner([
      {
        stdout: JSON.stringify({
          ok: true,
          process: {
            ProcessId: 4101,
            CommandLine: "C:\\opencode.exe serve --port 4101",
            CreationDate: "20260620103040.123456+000",
          },
        }),
        stderr: "",
      },
    ]);
    const processTable = createSystemManagedProcessTable({
      platform: "win32",
      commandRunner,
    });

    const inspection = await processTable.inspect(4101);

    expect(inspection).toEqual({
      status: "alive",
      snapshot: {
        pid: 4101,
        commandLine: "C:\\opencode.exe serve --port 4101",
        startedAt: `/Date(${Date.UTC(2026, 5, 20, 10, 30, 40) + 123})/`,
      },
    });
    expect(commandRunner.commands).toEqual([
      {
        command: windowsScriptHostPath(),
        args: [
          "//Nologo",
          "//E:jscript",
          resolveWindowsProcessIdentityScriptPath(),
          "/mode:query",
          "/pid:4101",
        ],
      },
    ]);
  });

  test("reports an absent Windows process only when the script says so", async () => {
    const absent = createSystemManagedProcessTable({
      platform: "win32",
      commandRunner: new FakeCommandRunner([
        { stdout: JSON.stringify({ ok: true, process: null }), stderr: "" },
      ]),
    });
    expect(await absent.inspect(4101)).toEqual({ status: "not-found" });

    // Empty output is not "not found": the script did not complete.
    const silent = createSystemManagedProcessTable({
      platform: "win32",
      commandRunner: new FakeCommandRunner([{ stdout: "", stderr: "" }]),
    });
    const inspection = await silent.inspect(4101);
    expect(inspection.status).toBe("error");
    expect((inspection as { error: unknown }).error).toBeInstanceOf(WindowsProcessIdentityError);
  });
});

/** Fake WMI and WScript objects for running the real identity script outside Windows. */
function runIdentityScriptSource(input: { mode: string; pid?: string; rows: unknown[] }) {
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  const queries: string[] = [];
  class Enumerator {
    private index = 0;
    constructor(private readonly items: unknown[]) {}
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
  runInNewContext(readFileSync(resolveWindowsProcessIdentityScriptPath(), "utf8"), {
    Enumerator,
    GetObject: (moniker: string) => {
      expect(moniker).toBe("winmgmts:{impersonationLevel=impersonate}!\\\\.\\root\\cimv2");
      return {
        ExecQuery: (wql: string) => {
          queries.push(wql);
          return input.rows;
        },
      };
    },
    WScript: {
      Arguments: {
        Named: { Item: (name: string) => ({ mode: input.mode, pid: input.pid })[name] },
      },
      StdOut: { Write: (text: string) => (stdout += text) },
      StdErr: { WriteLine: (text: string) => (stderr += text) },
      Quit: (code: number) => {
        exitCode = code;
      },
    },
  });
  return { stdout, stderr, exitCode, queries };
}

/** Runs the real script for each command, as cscript would, so the real parser reads its output. */
class ScriptCommandRunner implements ManagedProcessCommandRunner {
  readonly commands: Array<{ command: string; args: string[] }> = [];
  constructor(private readonly rows: unknown[]) {}

  async exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    this.commands.push({ command, args });
    const named = Object.fromEntries(
      args
        .filter((arg) => /^\/[a-z]+:/.test(arg))
        .map((arg) => arg.slice(1).split(":") as [string, string]),
    );
    const run = runIdentityScriptSource({ mode: named.mode!, pid: named.pid, rows: this.rows });
    if (run.exitCode !== 0) {
      throw Object.assign(new Error("Command failed"), { code: run.exitCode, stderr: run.stderr });
    }
    return { stdout: run.stdout, stderr: run.stderr };
  }
}

describe("Windows process identity", () => {
  const knownAscii = 'node "quote\\"d" back\\slash spa ce\ttab a<b>&c --paseo-terminal-worker id-1';
  const knownUnicode = "node uni-\u00e9-\u2211-\u{1F600} \u0001 line\r\nbreak";
  const creationDate = "20261105031555.123956+000";
  const recordedDate = `/Date(${Date.UTC(2026, 10, 5, 3, 15, 55) + 123})/`;

  test("resolves the script beside its module, and beside a bundle that stands in for it", () => {
    expect(path.basename(resolveWindowsProcessIdentityScriptPath())).toBe(
      WINDOWS_PROCESS_IDENTITY_SCRIPT_NAME,
    );
    // The source module's own script exists. A missing one must never read as "not found".
    expect(readFileSync(resolveWindowsProcessIdentityScriptPath(), "utf8")).toContain("winmgmts:");
    expect(
      resolveWindowsProcessIdentityScriptPath(
        "file:///runtime/terminal-worker/v1-abc/terminal-worker.mjs",
      ),
    ).toBe(path.join("/runtime/terminal-worker/v1-abc", WINDOWS_PROCESS_IDENTITY_SCRIPT_NAME));
    // cscript cannot read inside app.asar, so desktop resolves the unpacked copy.
    expect(
      resolveWindowsProcessIdentityScriptPath(
        "file:///app/resources/app.asar/node_modules/@getpaseo/server/dist/server/server/managed-processes/windows-process-identity.js",
      ),
    ).toContain(`${path.sep}app.asar.unpacked${path.sep}`);
  });

  test("names cscript under SystemRoot, whatever PATH holds", () => {
    expect(windowsScriptHostPath({ SystemRoot: "D:\\Win", PATH: "" })).toBe(
      "D:\\Win\\System32\\cscript.exe",
    );
    expect(windowsScriptHostPath({})).toBe("C:\\Windows\\System32\\cscript.exe");
  });

  test("converts CIM_DATETIME to the stored /Date(ms)/ string by floor, across offsets", () => {
    expect(cimDateTimeToRecordedStartedAt(creationDate)).toBe(recordedDate);
    // Rounding would give ...124 here. Stored strings are floored, as PowerShell printed them.
    expect(cimDateTimeToRecordedStartedAt("20261105031555.123999+000")).toBe(recordedDate);
    // The same instant reported at two offsets, as on either side of a daylight saving change.
    expect(cimDateTimeToRecordedStartedAt("20261105001555.123000-180")).toBe(recordedDate);
    expect(cimDateTimeToRecordedStartedAt("20261105041555.123000+060")).toBe(recordedDate);
    for (const missing of [null, undefined, "", "20261105031555.******+***", "2026-11-05", "x"]) {
      expect(cimDateTimeToRecordedStartedAt(missing)).toBeNull();
    }
  });

  test("converts real calendar instants across leap days and the widest Windows offsets", () => {
    expect(cimDateTimeToRecordedStartedAt("20240229120000.000000+000")).toBe(
      `/Date(${Date.UTC(2024, 1, 29, 12)})/`,
    );
    expect(cimDateTimeToRecordedStartedAt("20000229000000.000000+000")).toBe(
      `/Date(${Date.UTC(2000, 1, 29)})/`,
    );
    // UTC+14 and UTC-12 are the extremes of Windows time zones.
    expect(cimDateTimeToRecordedStartedAt("20261105140000.000000+840")).toBe(
      `/Date(${Date.UTC(2026, 10, 5)})/`,
    );
    expect(cimDateTimeToRecordedStartedAt("20261104120000.000000-720")).toBe(
      `/Date(${Date.UTC(2026, 10, 5)})/`,
    );
    expect(cimDateTimeToRecordedStartedAt("19700101000000.000000+000")).toBe("/Date(0)/");
  });

  test("refuses impossible dates instead of letting Date.UTC normalize them into an identity", () => {
    const impossible = [
      "20250229120000.000000+000", // February 29 outside a leap year
      "21000229120000.000000+000", // century years divisible by 100 but not 400 are not leap years
      "20261305031555.123000+000", // month 13
      "20260005031555.123000+000", // month 0
      "20261132031555.123000+000", // day 32
      "20260431031555.123000+000", // April 31
      "20261100031555.123000+000", // day 0
      "20261105241555.123000+000", // hour 24
      "20261105036055.123000+000", // minute 60
      "20261105031560.123000+000", // second 60
      "20261105031555.123000+841", // past UTC+14
      "20261105031555.123000-721", // past UTC-12
      "00500101000000.000000+000", // Date.UTC reads years 0 to 99 as 1900 to 1999
      "19691231235959.999999+000", // before the Unix epoch
      "19700101003000.000000+060", // the epoch in local time, but before it in UTC
    ];
    for (const value of impossible) {
      expect(cimDateTimeToRecordedStartedAt(value), value).toBeNull();
    }
  });

  test("returns known ASCII and Unicode command lines exactly as the script serializes them", async () => {
    // The real script and parser with fake COM objects: this proves serialization, not WMI.
    for (const commandLine of [knownAscii, knownUnicode, null]) {
      const runner = new ScriptCommandRunner([
        { ProcessId: 77, CommandLine: commandLine, CreationDate: creationDate },
      ]);
      expect(await readWindowsProcessIdentity(runner, 77)).toEqual({
        pid: 77,
        commandLine,
        startedAt: recordedDate,
      });
    }
    const raw = runIdentityScriptSource({
      mode: "query",
      pid: "77",
      rows: [{ ProcessId: 77, CommandLine: knownUnicode, CreationDate: creationDate }],
    });
    expect(raw.stdout).toMatch(/^[\x20-\x7e]+$/);
    expect(raw.queries).toEqual([
      "SELECT ProcessId,CommandLine,CreationDate FROM Win32_Process WHERE ProcessId = 77",
    ]);
    expect(await readWindowsProcessIdentity(new ScriptCommandRunner([]), 77)).toBeNull();
  });

  test("lists processes for both owners, dropping rows without a birth time as before", async () => {
    const rows = [
      { ProcessId: 0, ParentProcessId: 0, CreationDate: null },
      { ProcessId: 4, ParentProcessId: null, CreationDate: creationDate },
      { ProcessId: 8, ParentProcessId: 4, CreationDate: "" },
      { ProcessId: 9, ParentProcessId: 4, CreationDate: creationDate },
    ];
    expect(await listWindowsProcessTable(new ScriptCommandRunner(rows))).toEqual([
      { pid: 4, ppid: 0, startedAt: recordedDate },
      { pid: 9, ppid: 4, startedAt: recordedDate },
    ]);

    const runner = new ScriptCommandRunner(rows);
    const inspector = createTerminalWorkerProcessInspector({
      platform: "win32",
      commandRunner: runner,
    });
    expect(await inspector.listProcesses()).toEqual([
      { pid: 4, ppid: 0, startedAt: recordedDate, sessionId: null },
      { pid: 9, ppid: 4, startedAt: recordedDate, sessionId: null },
    ]);
    expect(runner.commands[0]?.args.slice(-1)).toEqual(["/mode:list"]);
  });

  test("never reads a failed, blocked, missing or malformed run as an absent process", async () => {
    const failure = async (run: () => Promise<unknown>) => {
      const error = await run().then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(WindowsProcessIdentityError);
      return error as WindowsProcessIdentityError;
    };
    const respond = (response: { stdout: string; stderr: string } | Error) => ({
      exec: async () => {
        if (response instanceof Error) throw response;
        return response;
      },
    });

    const blocked = await failure(() =>
      readWindowsProcessIdentity(
        respond(
          Object.assign(new Error("Command failed"), {
            code: 1,
            stderr: "Windows Script Host access is disabled on this machine.\r\n",
            stdout: '{"ok":true,"process":{"CommandLine":"private"}}',
          }),
        ),
        5,
      ),
    );
    expect(blocked.failure).toBe("script-failed");
    expect(blocked.message).toContain("exit code 1: Windows Script Host access is disabled");
    expect(blocked.message).toContain("allow that script to run");
    expect(blocked.message).toContain(resolveWindowsProcessIdentityScriptPath());
    // Neither the message nor the cause carries process output.
    expect(blocked.message).not.toContain("private");
    expect(String((blocked.cause as Error).message)).not.toContain("private");

    expect(
      (
        await failure(() =>
          readWindowsProcessIdentity(
            respond(Object.assign(new Error("spawn"), { code: "ENOENT" })),
            5,
          ),
        )
      ).failure,
    ).toBe("script-host-unavailable");
    expect(
      (
        await failure(() =>
          readWindowsProcessIdentity(
            respond(Object.assign(new Error("timeout"), { killed: true })),
            5,
          ),
        )
      ).failure,
    ).toBe("timed-out");

    for (const stdout of [
      "",
      "Microsoft (R) Windows Script Host Version 5.812",
      '{"ok":false}',
      '{"ok":true}',
      '{"ok":true,"process":{"ProcessId":6,"CommandLine":null,"CreationDate":null}}',
      "7",
    ]) {
      expect(
        (await failure(() => readWindowsProcessIdentity(respond({ stdout, stderr: "" }), 5)))
          .failure,
        stdout,
      ).toBe("malformed-result");
    }
    for (const stdout of [
      '{"ok":true,"processes":[{"ProcessId":-1}]}',
      '{"ok":true,"process":null}',
    ]) {
      expect(
        (await failure(() => listWindowsProcessTable(respond({ stdout, stderr: "" })))).failure,
      ).toBe("malformed-result");
    }

    const missing = await failure(() =>
      readWindowsProcessIdentity(respond({ stdout: "", stderr: "" }), 5, {
        scriptPath: path.join(tmpdir(), "missing-paseo-identity.js"),
      }),
    );
    expect(missing.failure).toBe("script-missing");

    const invalid = runIdentityScriptSource({ mode: "query", pid: "1 OR 1=1", rows: [] });
    expect(invalid.exitCode).toBe(3);
    expect(invalid.queries).toEqual([]);
  });

  test("keeps the identity script within ES3, which classic JScript and JScript9Legacy both run", () => {
    const source = readFileSync(resolveWindowsProcessIdentityScriptPath(), "utf8");
    const code = source.replace(/\/\/[^\n]*/g, "");
    // ES5 and later syntax classic JScript rejects, and anything that depends on a JSON global.
    expect(code).not.toMatch(/\b(?:let|const|class)\s|=>|`|\.\.\.|\bJSON\b/);
    expect(code).not.toMatch(/,\s*[\]}),]/);
    expect(code).not.toMatch(/\b(?:get|set)\s+\w+\s*\(/);
    // The build helpers and runtime copy refer to this exact file name.
    const builder = readFileSync(
      fileURLToPath(new URL("../../../scripts/build-terminal-worker.mjs", import.meta.url)),
      "utf8",
    );
    expect(builder).toContain(`"${WINDOWS_PROCESS_IDENTITY_SCRIPT_NAME}"`);
  });
});

class FakeProcessTable implements ManagedProcessTable {
  private readonly snapshots: Map<number, ManagedProcessSnapshot>;
  private readonly errorPids: Set<number>;

  constructor(snapshots: ManagedProcessSnapshot[], errorPids: number[] = []) {
    this.snapshots = new Map(snapshots.map((snapshot) => [snapshot.pid, snapshot]));
    this.errorPids = new Set(errorPids);
  }

  async inspect(pid: number): Promise<ManagedProcessInspection> {
    if (this.errorPids.has(pid)) {
      return { status: "error", error: new Error("inspection failed") };
    }
    const snapshot = this.snapshots.get(pid);
    return snapshot ? { status: "alive", snapshot } : { status: "not-found" };
  }
}

class FakeProcessTerminator {
  readonly terminatedPids: number[] = [];

  readonly terminate: ProcessTerminator = async (target: TreeKillTarget) => {
    this.terminatedPids.push(target.pid ?? -1);
    return "terminated";
  };
}

class FakeCommandRunner implements ManagedProcessCommandRunner {
  readonly commands: Array<{ command: string; args: string[] }> = [];
  private readonly responses: Array<{ stdout: string; stderr: string }>;

  constructor(responses: Array<{ stdout: string; stderr: string }>) {
    this.responses = [...responses];
  }

  async exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    this.commands.push({ command, args });
    const response = this.responses.shift();
    if (!response) {
      throw new Error("No fake process-table command response available");
    }
    return response;
  }
}
