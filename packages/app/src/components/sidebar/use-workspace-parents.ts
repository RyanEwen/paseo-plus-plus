import { useMemo } from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useSessionStore, type Agent } from "@/stores/session-store";
import type { SidebarWorkspacePlacement } from "@/hooks/use-sidebar-workspaces-list";
import {
  resolveWorkspaceParents,
  sameWorkspaceTreeAgents,
  type WorkspaceTreeSession,
} from "./workspace-tree";

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
      session.hasHydratedAgents !== next.hasHydratedAgents
    )
      return false;
    return sameWorkspaceTreeAgents(session.agents, next.agents);
  });
}

/**
 * Subscribe once for the sidebar, with agent IDs interpreted only inside their owning host.
 *
 * @param serverIds the distinct hosts of `workspaces` (`placementServerIds`), computed once by the
 *   sidebar model and shared with the drag authority.
 */
export function useWorkspaceParents(
  workspaces: readonly SidebarWorkspacePlacement[],
  serverIds: readonly string[],
) {
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
