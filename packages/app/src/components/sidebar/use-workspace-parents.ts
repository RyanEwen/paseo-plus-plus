import { useMemo } from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useSessionStore, type Agent } from "@/stores/session-store";
import type { SidebarWorkspacePlacement } from "@/hooks/use-sidebar-workspaces-list";
import { resolveWorkspaceParents, type WorkspaceTreeSession } from "./workspace-tree";

const relationshipSnapshots = new WeakMap<
  ReadonlyMap<string, Agent>,
  WorkspaceTreeSession["agents"]
>();

/** Cache the structural relationship view so timeline-only store changes are constant-time reads. */
function relationships(agents: ReadonlyMap<string, Agent>): WorkspaceTreeSession["agents"] {
  const cached = relationshipSnapshots.get(agents);
  if (cached) return cached;
  const snapshot = new Map(
    [...agents].map(([id, agent]) => [
      id,
      {
        id: agent.id,
        workspaceId: agent.workspaceId,
        parentAgentId: agent.parentAgentId,
        archivedAt: agent.archivedAt,
      },
    ]),
  );
  relationshipSnapshots.set(agents, snapshot);
  return snapshot;
}

/** Ignore runtime activity when comparing the relationship collection. */
function sameRelationships(left: WorkspaceTreeSession[], right: WorkspaceTreeSession[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((session, index) => {
    const next = right[index];
    if (
      session.serverId !== next.serverId ||
      session.hasHydratedAgents !== next.hasHydratedAgents ||
      session.agents.size !== next.agents.size
    )
      return false;
    if (session.agents === next.agents) return true;
    for (const [id, agent] of session.agents) {
      const other = next.agents.get(id);
      if (
        !other ||
        agent.workspaceId !== other.workspaceId ||
        agent.parentAgentId !== other.parentAgentId ||
        Boolean(agent.archivedAt) !== Boolean(other.archivedAt)
      )
        return false;
    }
    return true;
  });
}

/** Subscribe once for the sidebar, with agent IDs interpreted only inside their owning host. */
export function useWorkspaceParents(workspaces: readonly SidebarWorkspacePlacement[]) {
  const serverIds = useMemo(
    () => [...new Set(workspaces.map((workspace) => workspace.serverId))],
    [workspaces],
  );
  const sessions = useStoreWithEqualityFn(
    useSessionStore,
    (state) =>
      serverIds.flatMap((serverId) => {
        const session = state.sessions[serverId];
        return session
          ? [
              {
                serverId,
                hasHydratedAgents: session.hasHydratedAgents,
                agents: relationships(session.agents),
              },
            ]
          : [];
      }),
    sameRelationships,
  );
  return useMemo(() => resolveWorkspaceParents({ workspaces, sessions }), [workspaces, sessions]);
}
