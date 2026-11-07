import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { shallow } from "zustand/shallow";
import { useSidebarReorderGuard } from "@/hooks/use-sidebar-reorder-guard";
import { createFamilyDragTracker } from "./workspace-family-drag-tracker";
import {
  useSidebarWorkspaceTree,
  type WorkspaceFamilyDragAuthority,
} from "./workspace-tree-context";

/**
 * Observe authoritative inputs once per sidebar, without adding hot-store subscriptions per row.
 *
 * @param serverIds the distinct hosts that own the rendered families (`placementServerIds`).
 */
export function useWorkspaceFamilyDragAuthority(
  serverIds: readonly string[],
): WorkspaceFamilyDragAuthority {
  // Placement metadata can change without changing the hosts that own the projection.
  const hostScope = [...serverIds].sort();
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
