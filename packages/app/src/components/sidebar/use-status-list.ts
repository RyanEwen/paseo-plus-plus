import { useCallback, useMemo, useState } from "react";
import type { DragReorderMove } from "@/components/drag-reorder/reorder-items";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import { mergeWithRemainder } from "@/utils/sidebar-reorder";
import type { SidebarWorkspaceGroup } from "./sidebar-labels";
import {
  buildStatusListItems,
  resolveStatusGroupReorder,
  type StatusListItem,
} from "./status-list-items";
import { useOpenWorkspaceKeep, useSidebarLimitInputs } from "./use-limited-sidebar-group";
import { useSidebarWorkspaceTree } from "./workspace-tree-context";

const NO_EXPANDED_GROUPS: ReadonlySet<string> = new Set();

/** Add or remove one group key without mutating the current set. */
function toggleGroupKey(current: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(current);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** Map every workspace in the current projection to the status group it belongs to. */
function mapWorkspaceGroups(groups: readonly SidebarWorkspaceGroup[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const group of groups) {
    for (const workspace of group.rows) result.set(workspace.workspaceKey, group.key);
  }
  return result;
}

/**
 * Flatten status groups into list cells with the mode's count and age windows, per-group Show
 * more state, the open workspace kept visible and workspace families nested under their parents.
 *
 * @returns `items` for the list, `toggleExpanded(groupKey)` for a footer, and
 *   `resolveDestinationGroupKey(workspaceKey)`, which always reads the latest projection.
 */
export function useStatusListItems({
  groups,
  collapsedGroupKeys,
}: {
  groups: SidebarWorkspaceGroup[];
  collapsedGroupKeys: ReadonlySet<string>;
}) {
  const { initialCount, days, now } = useSidebarLimitInputs();
  const keep = useOpenWorkspaceKeep(useActiveWorkspaceSelection());
  const { tree: workspaceTree, activeWorkspaceKey } = useSidebarWorkspaceTree();
  const [expandedGroupKeys, setExpandedGroupKeys] = useState(NO_EXPANDED_GROUPS);

  const items = useMemo(
    () =>
      buildStatusListItems({
        groups,
        collapsedGroupKeys,
        expandedGroupKeys,
        initialCount,
        updatedWithin: days === null ? undefined : { days, now },
        keep,
        workspaceTree,
        activeWorkspaceKey,
      }),
    [
      groups,
      collapsedGroupKeys,
      expandedGroupKeys,
      initialCount,
      days,
      now,
      keep,
      workspaceTree,
      activeWorkspaceKey,
    ],
  );

  const toggleExpanded = useCallback((groupKey: string) => {
    setExpandedGroupKeys((current) => toggleGroupKey(current, groupKey));
  }, []);

  const destinationGroupKeys = useMemo(() => mapWorkspaceGroups(groups), [groups]);
  // Cleanup needs the new projection, even when a disappearing cell did not render again.
  const resolveDestinationGroupKey = useStableEvent((workspaceKey: string) =>
    destinationGroupKeys.get(workspaceKey),
  );

  return { items, toggleExpanded, resolveDestinationGroupKey };
}

/**
 * Persist a status-list drop as the moved group's saved order.
 *
 * @param canCommit the reorder guard's check, which rejects drops once sorting or filtering
 *   changed during the drag.
 * @returns the list's `onDragEnd` handler. Hidden rows of the group and every other group keep
 *   their saved relative order.
 */
export function useStatusReorderPersistence(
  items: readonly StatusListItem[],
  canCommit: () => boolean,
) {
  return useCallback(
    (reordered: StatusListItem[], move?: DragReorderMove) => {
      if (!canCommit() || !move) return;
      const reorderedVisibleKeys = resolveStatusGroupReorder({ items, reordered, move });
      if (!reorderedVisibleKeys) return;
      const store = useSidebarOrderStore.getState();
      store.setStatusWorkspaceOrder(
        mergeWithRemainder({ currentOrder: store.statusWorkspaceOrder, reorderedVisibleKeys }),
      );
    },
    [items, canCommit],
  );
}
