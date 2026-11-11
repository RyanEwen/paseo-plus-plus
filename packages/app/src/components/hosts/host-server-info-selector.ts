import type { DaemonServerInfo } from "@/stores/session-store";

/** The part of the session store this selector reads. */
interface SessionsWithServerInfo {
  sessions: Record<string, { serverInfo: DaemonServerInfo | null } | undefined>;
}

/** Server info for each listed host, keyed by server ID; null until a host reports it. */
export type HostServerInfoById = Readonly<Record<string, DaemonServerInfo | null>>;

/**
 * Build a session-store selector for the server info of `serverIds`. It returns the same object
 * while the sessions map is unchanged, so a collection can hold the store subscription and pass
 * stable facts to its rows.
 */
export function createHostServerInfoSelector(
  serverIds: readonly string[],
): (state: SessionsWithServerInfo) => HostServerInfoById {
  let previousSessions: SessionsWithServerInfo["sessions"] | null = null;
  let previousInfo: HostServerInfoById = {};

  return (state) => {
    if (state.sessions === previousSessions) return previousInfo;
    previousSessions = state.sessions;
    previousInfo = Object.fromEntries(
      serverIds.map((serverId) => [serverId, state.sessions[serverId]?.serverInfo ?? null]),
    );
    return previousInfo;
  };
}
