import {
  hasHumanAgentAttention,
  type HumanAttentionInput,
} from "@getpaseo/protocol/agent-attention";
import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import type { SidebarWorkspacePlacement } from "@/hooks/use-sidebar-workspaces-list";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";

/** Project only the shared attention fields and the authoritative workspace boundary. */
export type WorkspaceAttentionAgent = Pick<
  Agent,
  "workspaceId" | "archivedAt" | "requiresAttention" | "status" | "pendingPermissions"
> &
  Pick<HumanAttentionInput, "humanAttentionRequired">;

interface WorkspaceAttentionSession {
  agents: ReadonlyMap<string, WorkspaceAttentionAgent>;
  workspaces?: Map<string, WorkspaceDescriptor>;
}

interface WorkspaceAttentionMaps {
  agents: WorkspaceAttentionSession["agents"] | undefined;
  workspaces: WorkspaceAttentionSession["workspaces"];
}

/** Use host-owned workspace presentation; omitted metadata retains the older-host agent policy. */
export function buildWorkspaceHumanAttentionKeys(input: {
  workspaces: readonly SidebarWorkspacePlacement[];
  sessions: Readonly<Record<string, WorkspaceAttentionSession | undefined>>;
}): ReadonlySet<string> {
  const visibleByServer = new Map<string, Map<string, string>>();
  for (const workspace of input.workspaces) {
    const visible = visibleByServer.get(workspace.serverId) ?? new Map<string, string>();
    visible.set(workspace.workspaceId, workspace.workspaceKey);
    visibleByServer.set(workspace.serverId, visible);
  }
  const keys = new Set<string>();
  for (const [serverId, visible] of visibleByServer) {
    const session = input.sessions[serverId];
    if (!session) continue;
    const legacyVisible = new Map<string, string>();
    for (const [workspaceId, workspaceKey] of visible) {
      const descriptorKey = resolveWorkspaceMapKeyByIdentity({
        workspaces: session.workspaces,
        workspaceId,
      });
      const descriptor = descriptorKey ? session.workspaces?.get(descriptorKey) : undefined;
      const humanAttentionRequired = descriptor?.humanAttentionRequired;
      if (humanAttentionRequired === undefined) {
        legacyVisible.set(workspaceId, workspaceKey);
        continue;
      }
      if (humanAttentionRequired) keys.add(workspaceKey);
    }
    if (legacyVisible.size === 0) continue;

    for (const agent of session.agents.values()) {
      if (agent.archivedAt || !agent.workspaceId) continue;
      const workspaceKey = legacyVisible.get(agent.workspaceId);
      if (!workspaceKey) continue;
      const attention: HumanAttentionInput = {
        humanAttentionRequired: agent.humanAttentionRequired,
        requiresAttention: agent.requiresAttention,
        pendingPermissionCount: agent.pendingPermissions.length,
        status: agent.status,
      };
      if (hasHumanAgentAttention(attention)) keys.add(workspaceKey);
    }
  }
  return keys;
}

/** Cache both owning maps; unrelated timeline updates never recompute workspace attention. */
export function createWorkspaceHumanAttentionSelector(
  workspaces: readonly SidebarWorkspacePlacement[],
) {
  const serverIds = [...new Set(workspaces.map((workspace) => workspace.serverId))];
  let previousMaps: WorkspaceAttentionMaps[] | null = null;
  let previousKeys: ReadonlySet<string> = new Set();
  return function select(
    sessions: Readonly<Record<string, WorkspaceAttentionSession | undefined>>,
  ): ReadonlySet<string> {
    const maps = serverIds.map((serverId) => ({
      agents: sessions[serverId]?.agents,
      workspaces: sessions[serverId]?.workspaces,
    }));
    const cachedMaps = previousMaps;
    if (
      cachedMaps !== null &&
      maps.every(
        (map, index) =>
          map.agents === cachedMaps[index].agents &&
          map.workspaces === cachedMaps[index].workspaces,
      )
    )
      return previousKeys;
    previousMaps = maps;
    const keys = buildWorkspaceHumanAttentionKeys({ workspaces, sessions });
    if (keys.size !== previousKeys.size || [...keys].some((key) => !previousKeys.has(key)))
      previousKeys = keys;
    return previousKeys;
  };
}
