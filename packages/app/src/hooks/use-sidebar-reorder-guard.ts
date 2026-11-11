import { useSidebarQuickFilterStore } from "@/stores/sidebar-quick-filter-store";
import { useCallback, useEffect, useMemo } from "react";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import {
  canCommitSidebarReorder,
  sidebarReorderContext,
  sidebarReorderSort,
  type SidebarReorderDomain,
} from "@/utils/sidebar-reorder";

function currentReorderContext(domain: SidebarReorderDomain): string {
  const view = useSidebarViewStore.getState();
  return sidebarReorderContext(
    view,
    domain,
    useSidebarQuickFilterStore.getState().byMode[view.groupMode].text,
  );
}

/** One drag's admission state for a sidebar domain, independent of React. */
export interface SidebarReorderGuard {
  /** Start a drag from the context the list rendered; a stale render admits nothing. */
  begin(renderedContext: string): void;
  /** Forget the started drag once grouping, sorting or filters left its context. */
  invalidate(): void;
  /** Whether the started drag may commit now; manual pins skip the Custom sorting rule. */
  canCommit(manualPins?: boolean): boolean;
}

/**
 * Create the guard for one domain. Call invalidate() on every sidebar view or quick filter
 * change, so a context that changes away and back still rejects the drop.
 */
export function createSidebarReorderGuard(domain: SidebarReorderDomain): SidebarReorderGuard {
  let started: string | null = null;
  return {
    begin(renderedContext) {
      const current = currentReorderContext(domain);
      started = renderedContext === current ? current : null;
    },
    invalidate() {
      if (started !== currentReorderContext(domain)) started = null;
    },
    canCommit(manualPins = false) {
      return canCommitSidebarReorder({
        startedContext: started,
        currentContext: currentReorderContext(domain),
        sort: sidebarReorderSort(useSidebarViewStore.getState(), domain),
        manualPins,
      });
    },
  };
}

/** Reject a stale drop even if its sort/filter changes away and then back during the gesture. */
export function useSidebarReorderGuard(domain: SidebarReorderDomain) {
  const mode = useSidebarViewStore((state) => state.groupMode);
  const text = useSidebarQuickFilterStore((state) => state.byMode[mode].text);
  const context = useSidebarViewStore((state) => sidebarReorderContext(state, domain, text));
  const sort = useSidebarViewStore((state) => sidebarReorderSort(state, domain));
  const guard = useMemo(() => createSidebarReorderGuard(domain), [domain]);
  useEffect(() => {
    const stopView = useSidebarViewStore.subscribe(guard.invalidate);
    const stopText = useSidebarQuickFilterStore.subscribe(guard.invalidate);
    return () => {
      stopView();
      stopText();
    };
  }, [guard]);
  const onDragBegin = useCallback(() => guard.begin(context), [context, guard]);
  return { disabled: sort !== "custom", onDragBegin, canCommit: guard.canCommit };
}
