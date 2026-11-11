// Which probes run, in which order, and the exact inspector commands they reproduce.

export const COLD_FIRST_ORDERS = ["jscript", "query", "startup"];

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

/** The inspector's exact process list command (`listWindowsProcesses`), pinned by the same test. */
export const EXACT_PROCESS_LIST =
  "@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate) | ConvertTo-Json -Compress";

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
