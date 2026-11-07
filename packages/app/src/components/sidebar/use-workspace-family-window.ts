import { useCallback, useMemo } from "react";
import type { SidebarWorkspacePlacement } from "@/hooks/use-sidebar-workspaces-list";
import { useLimitedSidebarGroup } from "./use-limited-sidebar-group";
import {
  collectActiveWorkspaceKeys,
  includeActiveWorkspaceFamily,
  indexByWorkspaceKey,
  workspaceFamilyRoots,
  workspaceFamilyUpdatedAt,
} from "./workspace-tree";
import { useSidebarWorkspaceTree } from "./workspace-tree-context";

/**
 * Apply existing count and age preferences to whole families, preserving each child's own date.
 *
 * @param keep roots that stay visible past both windows, such as the open workspace; the active
 *   family and families with active work are revealed on top of it.
 */
export function useWorkspaceFamilyWindow<T extends SidebarWorkspacePlacement>(
  items: readonly T[],
  getStatusEnteredAt: (item: T) => Date | null,
  keep?: (item: T) => boolean,
) {
  const { tree, activeWorkspaceKey, entries } = useSidebarWorkspaceTree();
  const itemsByKey = useMemo(() => indexByWorkspaceKey(items), [items]);
  const activeWorkspaceKeys = useMemo(
    () => collectActiveWorkspaceKeys(entries, itemsByKey.keys()),
    [entries, itemsByKey],
  );
  const roots = useMemo(() => workspaceFamilyRoots(items, tree), [items, tree]);
  const getFamilyDate = useCallback(
    (workspace: T) =>
      workspaceFamilyUpdatedAt({
        workspaceKey: workspace.workspaceKey,
        tree,
        getStatusEnteredAt: (key) => {
          const item = itemsByKey.get(key);
          return item ? getStatusEnteredAt(item) : null;
        },
      }),
    [tree, itemsByKey, getStatusEnteredAt],
  );
  const limited = useLimitedSidebarGroup(roots, getFamilyDate, keep);
  // Stable identities: visibleItems feeds DraggableList data and drop-handler dependencies.
  const revealed = useMemo(() => {
    const visibleItems = includeActiveWorkspaceFamily({
      roots,
      visibleItems: limited.visibleItems,
      tree,
      activeWorkspaceKey,
      activeWorkspaceKeys,
    });
    // Already-visible active overflow needs no Show more; an expanded window keeps Show less.
    const canToggle =
      limited.canToggle && (limited.expanded || visibleItems.length < roots.length);
    return { visibleItems, canToggle };
  }, [
    roots,
    limited.visibleItems,
    limited.canToggle,
    limited.expanded,
    tree,
    activeWorkspaceKey,
    activeWorkspaceKeys,
  ]);
  return {
    expanded: limited.expanded,
    toggleExpanded: limited.toggleExpanded,
    visibleItems: revealed.visibleItems,
    canToggle: revealed.canToggle,
    itemsByKey,
  };
}
