import { useCallback, useMemo } from "react";
import type { SidebarWorkspacePlacement } from "@/hooks/use-sidebar-workspaces-list";
import { useLimitedSidebarGroup } from "./use-limited-sidebar-group";
import {
  collectActiveWorkspaceKeys,
  includeActiveWorkspaceFamily,
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
  const itemsByKey = useMemo(
    () => new Map(items.map((item) => [item.workspaceKey, item])),
    [items],
  );
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
  const window = useLimitedSidebarGroup(roots, getFamilyDate, keep);
  const visibleItems = includeActiveWorkspaceFamily({
    roots,
    visibleItems: window.visibleItems,
    tree,
    activeWorkspaceKey,
    activeWorkspaceKeys,
  });
  // Already-visible active overflow needs no Show more; an expanded window keeps Show less.
  const canToggle = window.canToggle && (window.expanded || visibleItems.length < roots.length);
  return { ...window, visibleItems, canToggle, itemsByKey };
}
