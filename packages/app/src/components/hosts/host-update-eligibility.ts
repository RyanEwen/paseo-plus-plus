import type { DaemonServerInfo } from "@/stores/session-store";

/**
 * How the sidebar may offer an update for one host:
 * - `checked`: the host answers read-only availability checks, so only a confirmed release is offered.
 * - `manual`: an older host without that check that Host Settings would also offer an update.
 * - `none`: no server info yet, the host reports that it cannot check, or an older host that
 *   cannot update itself, is desktop-managed, or already runs this app's version.
 */
export type HostUpdateSupport = "checked" | "manual" | "none";

/**
 * Read a host's update support from its last server_info. `versionDiffersFromApp` is the Host
 * Settings card's version check (`isVersionMismatch(appVersion, info.version)`).
 */
export function resolveHostUpdateSupport(
  info: DaemonServerInfo | null | undefined,
  { versionDiffersFromApp }: { versionDiffersFromApp: boolean },
): HostUpdateSupport {
  if (!info) return "none";
  const availability = info.features?.daemonUpdateAvailability;
  if (availability === true) return "checked";
  // COMPAT(daemonUpdateAvailability): added after v0.11.2, remove gate after 2027-04-14.
  // Older hosts cannot report a release, so offer the manual update only where the Host
  // Settings card would: the host can update itself, is not desktop-managed, and runs a
  // different version than this app.
  if (availability === undefined && canUpdateManually(info, versionDiffersFromApp)) {
    return "manual";
  }
  return "none";
}

function canUpdateManually(info: DaemonServerInfo, versionDiffersFromApp: boolean): boolean {
  return (
    info.features?.daemonSelfUpdate === true && info.desktopManaged !== true && versionDiffersFromApp
  );
}

/** The facts a sidebar host row needs before it may check or offer an update. */
export interface HostUpdateRowState {
  support: HostUpdateSupport;
  /** The host menu is open; a closed menu runs no checks and offers nothing. */
  enabled: boolean;
  connected: boolean;
  hasClient: boolean;
}

/** The latest availability check: settled means finished without an error. */
export interface HostUpdateCheckResult {
  settled: boolean;
  version: string | null;
}

/** Whether a row may ask its host for a newer release. */
export function shouldCheckHostUpdate(row: HostUpdateRowState): boolean {
  return row.enabled && row.support === "checked" && row.connected && row.hasClient;
}

/** Whether a row offers Update: failures and unknown eligibility never become an invitation. */
export function isHostUpdateOffered(row: HostUpdateRowState, check: HostUpdateCheckResult): boolean {
  const canRunUpdate = row.enabled && row.connected && row.hasClient;
  if (!canRunUpdate) return false;
  if (row.support === "manual") return true;
  return row.support === "checked" && check.settled && check.version !== null;
}
