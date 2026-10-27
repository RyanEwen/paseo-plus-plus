import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { shallow } from "zustand/shallow";
import { useSidebarReorderGuard } from "@/hooks/use-sidebar-reorder-guard";
import { useSessionStore, type SessionState } from "@/stores/session-store";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import {
  useSidebarWorkspaceTree,
  type WorkspaceFamilyDragAuthority,
} from "./workspace-tree-context";

/** Ignore activity-only agent updates while detecting authoritative topology and directory changes. */
function sameFamilySession(
  previous: SessionState | undefined,
  next: SessionState | undefined,
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return false;
  if (
    previous.workspaces !== next.workspaces ||
    previous.projects !== next.projects ||
    previous.workspaceAgentActivity !== next.workspaceAgentActivity ||
    previous.hasHydratedAgents !== next.hasHydratedAgents ||
    previous.hasHydratedWorkspaces !== next.hasHydratedWorkspaces ||
    previous.hasWorkspaceDirectorySnapshot !== next.hasWorkspaceDirectorySnapshot
  )
    return false;
  if (previous.agents === next.agents) return true;
  if (previous.agents.size !== next.agents.size) return false;
  for (const [id, agent] of previous.agents) {
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
}

/**
 * One collection-owned generation observes each store transition synchronously, including
 * away-and-back changes hidden by React batching. Live reads also reject a queued callback
 * before the subscription's turn in the store's notification list.
 */
function createFamilyDragTracker(serverIds: readonly string[]) {
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

/** Observe authoritative inputs once per sidebar, without adding hot-store subscriptions per row. */
export function useWorkspaceFamilyDragAuthority(
  serverIds: readonly string[],
): WorkspaceFamilyDragAuthority {
  // Placement metadata can change without changing the hosts that own the projection.
  const hostScope = [...new Set(serverIds)].sort();
  const scopeRef = useRef(hostScope);
  if (!shallow(scopeRef.current, hostScope)) scopeRef.current = hostScope;
  const stableHostScope = scopeRef.current;
  const tracker = useMemo(() => createFamilyDragTracker(stableHostScope), [stableHostScope]);
  const renderedGeneration = useSyncExternalStore(
    tracker.subscribe,
    tracker.getSnapshot,
    tracker.getSnapshot,
  );
  return useMemo(
    () => ({ renderedGeneration, getGeneration: tracker.getSnapshot }),
    [renderedGeneration, tracker],
  );
}

interface WorkspaceFamilyDragAdmission {
  authority: WorkspaceFamilyDragAuthority;
  generation: number;
  revision: string;
}

/** Cancel a drop if relationship, sibling order or collapse changed while its family was moving. */
export function useWorkspaceFamilyDrag() {
  const {
    disabled,
    onDragBegin: beginSidebarDrag,
    canCommit: canCommitSidebarDrag,
  } = useSidebarReorderGuard("workspace");
  const { revision: current, dragAuthority } = useSidebarWorkspaceTree();
  const currentRef = useRef(current);
  const authorityRef = useRef(dragAuthority);
  const startedRef = useRef<WorkspaceFamilyDragAdmission | null>(null);
  if (currentRef.current !== current || authorityRef.current !== dragAuthority)
    startedRef.current = null;
  currentRef.current = current;
  authorityRef.current = dragAuthority;
  const onDragBegin = useCallback(() => {
    beginSidebarDrag();
    startedRef.current = null;
    const authority = authorityRef.current;
    if (authority === null) return;
    const liveGeneration = authority.getGeneration();
    if (liveGeneration !== authority.renderedGeneration) return;
    startedRef.current = { authority, generation: liveGeneration, revision: currentRef.current };
  }, [beginSidebarDrag]);
  const canCommit = useCallback(
    (manualPins = false) => {
      const admission = startedRef.current;
      const authority = authorityRef.current;
      if (admission === null || authority === null) return false;
      // Generations belong to one authority; a replacement can start at the same number.
      if (admission.authority !== authority || admission.revision !== currentRef.current)
        return false;
      if (admission.generation !== authority.getGeneration()) return false;
      return canCommitSidebarDrag(manualPins);
    },
    [canCommitSidebarDrag],
  );
  return { disabled, onDragBegin, canCommit };
}
