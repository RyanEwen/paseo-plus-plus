import type { DaemonServerInfo } from "@/stores/session-store";

/**
 * How the sidebar may offer an update for one host:
 * - `checked`: the host answers read-only availability checks, so only a confirmed release is offered.
 * - `manual`: an older host without that check, offered the shared manual update.
 * - `none`: no server info yet, or the host reports that it cannot check.
 */
export type HostUpdateSupport = "checked" | "manual" | "none";

/** Read a host's update support from its last server_info. */
export function resolveHostUpdateSupport(
  info: DaemonServerInfo | null | undefined,
): HostUpdateSupport {
  if (!info) return "none";
  // COMPAT(daemonUpdateAvailability): added after v0.11.2, remove gate after 2027-04-14.
  const availability = info.features?.daemonUpdateAvailability;
  if (availability === true) return "checked";
  if (availability === undefined) return "manual";
  return "none";
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
