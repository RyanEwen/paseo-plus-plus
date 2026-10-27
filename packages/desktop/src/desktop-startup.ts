export interface DesktopRendererClientOptions {
  platform: NodeJS.Platform;
  realUserId: number | undefined;
  commandLine: Pick<Electron.CommandLine, "hasSwitch" | "appendSwitch">;
}

/**
 * Keep Electron 44.5.1's service-worker preload realm available in non-root Linux
 * launches that already disable Chromium's OS sandbox. Retaining no-sandbox keeps
 * OS isolation disabled; only Electron's sandbox-compatible renderer client is
 * selected. Root and unknown UIDs keep their existing startup behavior.
 */
export function configureDesktopRendererClient(input: DesktopRendererClientOptions): void {
  if (input.platform !== "linux" || input.realUserId === undefined) {
    return;
  }
  if (!Number.isSafeInteger(input.realUserId) || input.realUserId <= 0) {
    return;
  }
  if (!input.commandLine.hasSwitch("no-sandbox") || input.commandLine.hasSwitch("enable-sandbox")) {
    return;
  }

  input.commandLine.appendSwitch("enable-sandbox");
}

export interface DesktopStartupDependencies {
  hasPendingGuiLaunchRequest: boolean;
  runCliPassthroughIfRequested: () => Promise<boolean>;
  inheritLoginShellEnv: () => void;
  bootstrapGui: () => Promise<void>;
}

export async function runDesktopStartup(deps: DesktopStartupDependencies): Promise<void> {
  if (!deps.hasPendingGuiLaunchRequest && (await deps.runCliPassthroughIfRequested())) {
    return;
  }

  deps.inheritLoginShellEnv();
  await deps.bootstrapGui();
}
