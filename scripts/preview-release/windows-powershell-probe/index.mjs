import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { release as osRelease, tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { performance } from "node:perf_hooks";
import { isMainModule } from "../../is-main-module.mjs";
import { buildComparison } from "./compare.mjs";
import { JSCRIPT_WMI_SOURCE } from "./jscript-source.mjs";
import { buildProbePlan, requireDiagnosticOnly } from "./plan.mjs";
import { MAX_RETAINED_OUTPUT_BYTES, runProbe } from "./run-probe.mjs";

// The probe's public surface: the workflow runs this file, and its tests import from it.
export {
  buildComparison,
  compareDates,
  compareProcessLists,
  compareQueryTarget,
  dateShape,
  dmtfToEpochMicros,
  summarizeCompatibility,
} from "./compare.mjs";
export { JSCRIPT_WMI_SOURCE } from "./jscript-source.mjs";
export {
  buildProbePlan,
  COLD_FIRST_ORDERS,
  EXACT_PROCESS_LIST,
  exactSelfQuery,
  requireDiagnosticOnly,
} from "./plan.mjs";
export { LONGEST_PROBE_MS, runProbe, sanitizeErrorLine } from "./run-probe.mjs";

// Diagnostic only. Measures how Windows PowerShell behaves on Windows runners, where the terminal
// worker's self-inspection has not returned within its readiness deadline on ARM64, and whether
// inbox JScript with WMI could report the same process identity. It builds and publishes nothing,
// changes no application behavior, and its results are not release qualification.

// No new probe starts after this, so the last one and the upload both fit the 30-minute job cap
// even if every probe reaches the ceiling. Results are written after each probe either way.
export const TOTAL_PROBE_BUDGET_MS = 24 * 60_000;

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
