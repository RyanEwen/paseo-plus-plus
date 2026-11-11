import {
  useSessionStore,
  type SessionState,
  type WorkspaceDescriptor,
} from "@/stores/session-store";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import { sameWorkspaceTreeAgents } from "./workspace-tree";

/**
 * Whether a workspace update can change a family's rows: which workspaces exist, the project that
 * bounds a family, background visibility and the pin partitions. Status, names, diff stats and
 * other record updates arrive constantly and leave a queued sibling drop valid.
 */
function sameFamilyWorkspaces(
  previous: ReadonlyMap<string, WorkspaceDescriptor>,
  next: ReadonlyMap<string, WorkspaceDescriptor>,
): boolean {
  if (previous === next) return true;
  if (previous.size !== next.size) return false;
  for (const [id, workspace] of previous) {
    const other = next.get(id);
    if (!other) return false;
    if (workspace.projectId !== other.projectId) return false;
    if (Boolean(workspace.background) !== Boolean(other.background)) return false;
    if (workspace.pinnedAt !== other.pinnedAt) return false;
    if (workspace.projectPinnedAt !== other.projectPinnedAt) return false;
  }
  return true;
}

/**
 * Ignore activity-only agent updates while detecting authoritative topology and directory changes.
 * Status changes rebuild the derived activity index without moving a row in Project view, and a
 * Status view regroup already changes the projection revision, so the index is not compared.
 */
function sameFamilySession(
  previous: SessionState | undefined,
  next: SessionState | undefined,
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return false;
  if (
    !sameFamilyWorkspaces(previous.workspaces, next.workspaces) ||
    previous.projects !== next.projects ||
    previous.hasHydratedAgents !== next.hasHydratedAgents ||
    previous.hasHydratedWorkspaces !== next.hasHydratedWorkspaces ||
    previous.hasWorkspaceDirectorySnapshot !== next.hasWorkspaceDirectorySnapshot
  )
    return false;
  return sameWorkspaceTreeAgents(previous.agents, next.agents);
}

/**
 * One collection-owned generation observes each store transition synchronously, including
 * away-and-back changes hidden by React batching. Live reads also reject a queued callback
 * before the subscription's turn in the store's notification list.
 *
 * @param serverIds the hosts whose sessions own the rendered families.
 * @returns `getSnapshot`, the current generation (it advances when relationships, family placement,
 *   collapse or saved order change), and `subscribe` for `useSyncExternalStore`. Unsubscribing
 *   advances the generation so a drop held by an unmounted collection cannot commit.
 */
export function createFamilyDragTracker(serverIds: readonly string[]) {
  let generation = 0;
  let sessions = serverIds.map((id) => useSessionStore.getState().sessions[id]);
  let collapse = useSidebarCollapsedSectionsStore.getState();
  let order = useSidebarOrderStore.getState();

  function getSnapshot(): number {
    const nextSessions = serverIds.map((id) => useSessionStore.getState().sessions[id]);
    const nextCollapse = useSidebarCollapsedSectionsStore.getState();
    const nextOrder = useSidebarOrderStore.getState();
    const sameSessions = sessions.every((session, index) =>
      sameFamilySession(session, nextSessions[index]),
    );
    const sameCollapse =
      collapse.collapsedProjectKeys === nextCollapse.collapsedProjectKeys &&
      collapse.collapsedWorkspaceGroupKeys === nextCollapse.collapsedWorkspaceGroupKeys &&
      collapse.collapsedPinned === nextCollapse.collapsedPinned;
    const sameOrder =
      order.projectOrder === nextOrder.projectOrder &&
      order.workspaceOrderByProject === nextOrder.workspaceOrderByProject &&
      order.statusWorkspaceOrder === nextOrder.statusWorkspaceOrder &&
      order.pinnedWorkspaceOrder === nextOrder.pinnedWorkspaceOrder;
    if (!sameSessions || !sameCollapse || !sameOrder) generation += 1;
    sessions = nextSessions;
    collapse = nextCollapse;
    order = nextOrder;
    return generation;
  }

  function subscribe(onChange: () => void): () => void {
    const invalidate = () => {
      getSnapshot();
      onChange();
    };
    const stopSession = useSessionStore.subscribe(invalidate);
    const stopCollapse = useSidebarCollapsedSectionsStore.subscribe(invalidate);
    const stopOrder = useSidebarOrderStore.subscribe(invalidate);
    return () => {
      stopSession();
      stopCollapse();
      stopOrder();
      // A callback held by an unmounted collection no longer owns any drop.
      generation += 1;
    };
  }
  return { getSnapshot, subscribe };
}
