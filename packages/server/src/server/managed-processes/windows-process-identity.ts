import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { resolveExternalProcessPath } from "../../terminal/paseo-cli-path.js";

// Windows process identity through inbox WMI, run by cscript.exe as JScript. It replaced Windows
// PowerShell, whose first start and CimCmdlets load can take longer than the terminal worker's
// readiness deadline on Windows ARM64. Identity strings stay exactly what PowerShell stored:
// CreationDate as `/Date(<ms>)/`, floored to the millisecond, so records written before the
// switch keep matching. There is no fallback: where policy blocks cscript scripts, identity fails
// with an error saying so. See docs/terminal-worker.md.

export const WINDOWS_PROCESS_IDENTITY_SCRIPT_NAME = "windows-process-identity-script.js";

const STDERR_DETAIL_LENGTH = 200;

export interface WindowsIdentityCommandRunner {
  exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
}

/** A Windows process's identity, in the exact strings existing records hold. */
export interface WindowsProcessIdentity {
  pid: number;
  commandLine: string | null;
  startedAt: string | null;
}

/** One process-table row with a birth time. Rows without one are left out, as before. */
export interface WindowsProcessTableRow {
  pid: number;
  ppid: number;
  startedAt: string;
}

/** Where to find the script. Production resolves it from this module; tests pass a path. */
export interface WindowsIdentityScriptOptions {
  scriptPath?: string;
}

export type WindowsProcessIdentityFailure =
  | "script-missing"
  | "script-host-unavailable"
  | "script-failed"
  | "timed-out"
  | "malformed-result";

/**
 * The identity script could not report identity. This is never "process not found". The message
 * names the cause and what an operator can do, and never includes process output.
 */
export class WindowsProcessIdentityError extends Error {
  readonly failure: WindowsProcessIdentityFailure;

  constructor(
    failure: WindowsProcessIdentityFailure,
    message: string,
    options?: { cause?: Error },
  ) {
    super(message, options);
    this.name = "WindowsProcessIdentityError";
    this.failure = failure;
  }
}

/**
 * cscript.exe by its install path. Process identity must not depend on the caller's PATH: a
 * daemon or terminal worker can run with a PATH that does not reach System32.
 */
export function windowsScriptHostPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.win32.join(
    env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows",
    "System32",
    "cscript.exe",
  );
}

/**
 * The identity script as a file cscript can read. It sits beside this module in source and in
 * the built server, and beside the terminal worker bundle in the bundle and its runtime copy,
 * because the bundle's own URL stands in for this module's there. Inside the desktop app this
 * maps app.asar to app.asar.unpacked, where electron-builder places it.
 * @param moduleUrl the URL of the code resolving it, for tests
 */
export function resolveWindowsProcessIdentityScriptPath(
  moduleUrl: string = import.meta.url,
): string {
  return resolveExternalProcessPath(
    fileURLToPath(new URL(`./${WINDOWS_PROCESS_IDENTITY_SCRIPT_NAME}`, moduleUrl)),
  );
}

/** Windows time zones run from UTC-12 to UTC+14. */
const MIN_UTC_OFFSET_MINUTES = -12 * 60;
const MAX_UTC_OFFSET_MINUTES = 14 * 60;

const CIM_DATETIME_PATTERN = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})$/;

/** The fields of one CIM_DATETIME, in the local time its offset describes. */
interface CimDateTimeFields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  micros: number;
  offsetMinutes: number;
}

/** Reads the fixed-width fields, or null when the text is not a complete CIM_DATETIME. */
function parseCimDateTimeFields(value: string): CimDateTimeFields | null {
  const match = CIM_DATETIME_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  const [year, month, day, hour, minute, second, micros, offset] = [
    match[1],
    match[2],
    match[3],
    match[4],
    match[5],
    match[6],
    match[7],
    match[9],
  ].map(Number) as [number, number, number, number, number, number, number, number];
  const offsetMinutes = match[8] === "-" ? -offset : offset;
  return { year, month, day, hour, minute, second, micros, offsetMinutes };
}

/**
 * Whether the local fields name a real wall-clock time with a real Windows offset. Date.UTC
 * silently normalizes out-of-range fields, so month 13 or February 29 of a common year would
 * otherwise become a different, valid-looking instant. Second 60 is refused: Windows derives
 * CreationDate from a FILETIME, which has no leap seconds.
 */
function isRealCimDateTime(fields: CimDateTimeFields): boolean {
  if (fields.month < 1 || fields.month > 12) {
    return false;
  }
  if (fields.day < 1 || fields.day > daysInMonth(fields.year, fields.month)) {
    return false;
  }
  if (fields.hour > 23 || fields.minute > 59 || fields.second > 59) {
    return false;
  }
  return (
    fields.offsetMinutes >= MIN_UTC_OFFSET_MINUTES && fields.offsetMinutes <= MAX_UTC_OFFSET_MINUTES
  );
}

/** Days in each month of a common year, January first. */
const COMMON_YEAR_MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Days in a month, 1 to 12, of a Gregorian year. */
function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) {
    return 29;
  }
  return COMMON_YEAR_MONTH_DAYS[month - 1] ?? 0;
}

/** Gregorian leap years: every fourth year, except centuries not divisible by 400. */
function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Converts WMI's CIM_DATETIME (yyyymmddHHMMSS.mmmmmmsUUU, UUU being minutes from UTC) to the
 * `/Date(<ms>)/` string Windows PowerShell 5.1 printed and existing records hold. Floor, not
 * round: the Windows probe found rounding wrong for about half of all processes.
 *
 * Only real instants from the Unix epoch onward are supported. An impossible field, an offset
 * outside UTC-12 to UTC+14, or an instant before 1970 UTC returns null rather than a synthesized
 * identity. Years 0 to 99 always fall in that last group, so Date.UTC's reading of them as 1900
 * to 1999 never reaches a result.
 * @returns null for a missing, wildcard or malformed value, which identity treats as unknown
 */
export function cimDateTimeToRecordedStartedAt(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const fields = parseCimDateTimeFields(value);
  if (!fields || fields.year < 1970 || !isRealCimDateTime(fields)) {
    return null;
  }

  const localMs = Date.UTC(
    fields.year,
    fields.month - 1,
    fields.day,
    fields.hour,
    fields.minute,
    fields.second,
  );
  const utcMs = localMs - fields.offsetMinutes * 60_000 + Math.floor(fields.micros / 1_000);
  if (utcMs < 0) {
    return null;
  }
  return `/Date(${utcMs})/`;
}

const QueryResultSchema = z.object({
  ok: z.literal(true),
  process: z
    .object({
      ProcessId: z.number().int().positive(),
      CommandLine: z.string().nullable(),
      CreationDate: z.string().nullable(),
    })
    .nullable(),
});

const ListResultSchema = z.object({
  ok: z.literal(true),
  processes: z.array(
    z.object({
      ProcessId: z.number().int().nonnegative(),
      ParentProcessId: z.number().int().nonnegative().nullable(),
      CreationDate: z.string().nullable(),
    }),
  ),
});

function guidance(scriptPath: string): string {
  return (
    `Paseo runs ${scriptPath} with cscript.exe to identify its own processes on Windows. ` +
    "If Windows Script Host, AppLocker or App Control blocks scripts on this machine, allow that script to run."
  );
}

/** Describes a failed run without process output: exit code, signal, and cscript's first stderr line. */
function describeRun(error: unknown): { failure: WindowsProcessIdentityFailure; detail: string } {
  const details = (error ?? {}) as {
    code?: unknown;
    killed?: unknown;
    signal?: unknown;
    stderr?: unknown;
  };
  if (details.code === "ENOENT") {
    return { failure: "script-host-unavailable", detail: "cscript.exe was not found" };
  }
  if (details.killed === true) {
    return { failure: "timed-out", detail: "cscript.exe did not finish in time" };
  }
  const exit = typeof details.code === "number" ? `exit code ${details.code}` : "it did not start";
  const stderrLine =
    typeof details.stderr === "string"
      ? (details.stderr.split(/\r?\n/).find((line) => line.trim() !== "") ?? "").trim()
      : "";
  const detail = stderrLine ? `${exit}: ${stderrLine.slice(0, STDERR_DETAIL_LENGTH)}` : exit;
  return { failure: "script-failed", detail };
}

/** Runs the script and returns its parsed JSON. Every way it can fail is a typed error. */
async function runIdentityScript(
  runner: WindowsIdentityCommandRunner,
  args: string[],
  options: WindowsIdentityScriptOptions,
): Promise<unknown> {
  const scriptPath = options.scriptPath ?? resolveWindowsProcessIdentityScriptPath();
  try {
    await access(scriptPath);
  } catch {
    throw new WindowsProcessIdentityError(
      "script-missing",
      `Paseo's Windows process identity script is missing from ${scriptPath}. Reinstall or rebuild Paseo.`,
    );
  }
  let stdout: string;
  try {
    ({ stdout } = await runner.exec(windowsScriptHostPath(), [
      "//Nologo",
      "//E:jscript",
      scriptPath,
      ...args,
    ]));
  } catch (error) {
    const { failure, detail } = describeRun(error);
    // The cause keeps the failure's kind, not the command's output.
    throw new WindowsProcessIdentityError(
      failure,
      `Windows Script Host could not report process identity (${detail}). ${guidance(scriptPath)}`,
      { cause: new Error(detail) },
    );
  }
  try {
    return JSON.parse(stdout.trim());
  } catch {
    throw new WindowsProcessIdentityError(
      "malformed-result",
      `Windows Script Host ran but printed no identity result. ${guidance(scriptPath)}`,
    );
  }
}

/**
 * Reads one process's identity.
 * @returns null only when the script ran and no process has that id
 */
export async function readWindowsProcessIdentity(
  runner: WindowsIdentityCommandRunner,
  pid: number,
  options: WindowsIdentityScriptOptions = {},
): Promise<WindowsProcessIdentity | null> {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new RangeError(`Not a process id: ${pid}`);
  }
  const parsed = QueryResultSchema.safeParse(
    await runIdentityScript(runner, ["/mode:query", `/pid:${pid}`], options),
  );
  if (!parsed.success) {
    throw new WindowsProcessIdentityError(
      "malformed-result",
      "The process identity result was malformed.",
    );
  }
  const found = parsed.data.process;
  if (found === null) return null;
  if (found.ProcessId !== pid) {
    throw new WindowsProcessIdentityError(
      "malformed-result",
      `The process identity result named another process than ${pid}.`,
    );
  }
  return {
    pid,
    commandLine: found.CommandLine,
    startedAt: cimDateTimeToRecordedStartedAt(found.CreationDate),
  };
}

/** Lists every process that has a birth time. Fails rather than returning a partial table. */
export async function listWindowsProcessTable(
  runner: WindowsIdentityCommandRunner,
  options: WindowsIdentityScriptOptions = {},
): Promise<WindowsProcessTableRow[]> {
  const parsed = ListResultSchema.safeParse(
    await runIdentityScript(runner, ["/mode:list"], options),
  );
  if (!parsed.success) {
    throw new WindowsProcessIdentityError(
      "malformed-result",
      "The process table result was malformed.",
    );
  }
  return parsed.data.processes.flatMap((row) => {
    const startedAt = cimDateTimeToRecordedStartedAt(row.CreationDate);
    return startedAt ? [{ pid: row.ProcessId, ppid: row.ParentProcessId ?? 0, startedAt }] : [];
  });
}
