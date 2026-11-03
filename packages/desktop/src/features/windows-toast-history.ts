import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WINDOWS_FORK_APP_ID } from "../distribution.js";
import { z } from "zod";
import type { DeliveredAgentToast } from "./viewed-agent-notifications.js";

interface WindowsToastHistoryOwner {
  executable: string;
  isPackagedFork: boolean;
}

interface WindowsToastHistoryOperation {
  operation: "list" | "remove" | "removeCurrentLive";
  toasts: DeliveredAgentToast[];
}

const execFileAsync = promisify(execFile);
const historySchema = z.array(
  z.object({
    tag: z.string(),
    group: z.string(),
    arguments: z.string(),
    namespace: z.enum(["current", "legacy"]),
  }),
);

// This is static code, not an interpolation target for provider-controlled text.
// The owned installer shortcut authorizes the current identity and the one known
// historical fork namespace. Namespace provenance never comes from renderer input.
const script = String.raw`
$ErrorActionPreference = 'Stop'
$inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
$exe = [IO.Path]::GetFullPath($inputData.executable)
$product = [Diagnostics.FileVersionInfo]::GetVersionInfo($exe).ProductName
if ($product -ne 'Paseo++') { throw 'Only the packaged Paseo++ fork identity may inspect toast history' }
$expectedId = [string]$inputData.appId
$namespaces = @{ current = $expectedId; legacy = 'electron.app.' + $product }
$linkPath = Join-Path ([Environment]::GetFolderPath('StartMenu')) ('Programs\' + $product + '.lnk')
$wsh = New-Object -ComObject WScript.Shell
$link = $wsh.CreateShortcut($linkPath)
$stub = Join-Path ([IO.Path]::GetDirectoryName([IO.Path]::GetDirectoryName($exe))) ([IO.Path]::GetFileName($exe))
$ownsShortcut = ($link.TargetPath -eq $exe) -or ((Test-Path $stub) -and ($link.TargetPath -eq $stub))
if (-not $ownsShortcut) { throw 'Cannot verify the notification shortcut belongs to this executable' }
$shell = New-Object -ComObject Shell.Application
$item = $shell.NameSpace([IO.Path]::GetDirectoryName($linkPath)).ParseName([IO.Path]::GetFileName($linkPath))
$appId = $item.ExtendedProperty('System.AppUserModel.ID')
if ($appId -cne $expectedId) { throw 'Notification shortcut does not match the packaged distribution identity; history left untouched' }
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$history = [Windows.UI.Notifications.ToastNotificationManager]::History
if ($inputData.operation -eq 'list') {
  $entries = @(foreach ($namespace in @('current', 'legacy')) {
    foreach ($toast in $history.GetHistory([string]$namespaces[$namespace])) {
      [PSCustomObject]@{ tag = $toast.Tag; group = $toast.Group; arguments = $toast.Content.DocumentElement.GetAttribute('launch'); namespace = $namespace }
    }
  })
  ConvertTo-Json -InputObject $entries -Compress -Depth 4
} elseif ($inputData.operation -eq 'remove') {
  foreach ($toast in $inputData.toasts) {
    $namespace = [string]$toast.namespace
    if (-not (@('current', 'legacy') -ccontains $namespace)) { throw 'History namespace is required' }
    if ([string]::IsNullOrEmpty($toast.tag)) { throw 'A toast tag is required' }
    $identity = [string]$namespaces[$namespace]
    foreach ($actual in $history.GetHistory($identity)) {
      if ($actual.Tag -ceq [string]$toast.tag -and $actual.Group -ceq [string]$toast.group -and $actual.Content.DocumentElement.GetAttribute('launch') -ceq [string]$toast.arguments) {
        $history.Remove([string]$actual.Tag, [string]$actual.Group, $identity)
      }
    }
  }
} elseif ($inputData.operation -eq 'removeCurrentLive') {
  foreach ($toast in $inputData.toasts) {
    if ([string]::IsNullOrEmpty($toast.tag)) { throw 'A live notification tag is required' }
    $history.Remove([string]$toast.tag, 'Notifications', $expectedId)
  }
} else { throw 'Unsupported toast operation' }
`;

/** Inspect only the executable-owned, verified fork shortcut; never change the process AUMID. */
export function createWindowsToastHistory(owner: WindowsToastHistoryOwner) {
  async function run(request: WindowsToastHistoryOperation): Promise<string> {
    if (!owner.isPackagedFork)
      throw new Error("Durable notification history requires the packaged fork identity");
    const child = execFileAsync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 },
    );
    child.child.stdin?.end(
      JSON.stringify({
        executable: owner.executable,
        appId: WINDOWS_FORK_APP_ID,
        operation: request.operation,
        toasts: request.toasts,
      }),
    );
    const { stdout } = await child;
    return stdout.replace(/^\uFEFF/, "").trim();
  }
  return {
    async list(): Promise<DeliveredAgentToast[]> {
      return historySchema.parse(JSON.parse(await run({ operation: "list", toasts: [] })));
    },
    /** Only the main-process on-show path supplies its freshly created UUID.
     * This never searches or removes from legacy history. */
    async removeCurrentLive(tag: string): Promise<void> {
      await run({
        operation: "removeCurrentLive",
        toasts: [{ tag, group: "Notifications", arguments: "" }],
      });
    },
    async remove(toasts: DeliveredAgentToast[]): Promise<void> {
      await run({ operation: "remove", toasts });
    },
  };
}
