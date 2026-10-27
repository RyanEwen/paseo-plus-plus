import { useCallback, useMemo } from "react";
import type { SidebarWorkspacePlacement } from "@/hooks/use-sidebar-workspaces-list";
import { useLimitedSidebarGroup } from "./use-limited-sidebar-group";
import {
  includeActiveWorkspaceFamily,
  workspaceFamilyRoots,
  workspaceFamilyUpdatedAt,
} from "./workspace-tree";
import { useSidebarWorkspaceTree } from "./workspace-tree-context";

/** Apply existing count and age preferences to whole families, preserving each child's own date. */
export function useWorkspaceFamilyWindow<T extends SidebarWorkspacePlacement>(
  items: readonly T[],
  getStatusEnteredAt: (item: T) => Date | null,
) {
  const { tree, activeWorkspaceKey } = useSidebarWorkspaceTree();
  const itemsByKey = useMemo(
    () => new Map(items.map((item) => [item.workspaceKey, item])),
    [items],
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
  const window = useLimitedSidebarGroup(roots, getFamilyDate);
  const visibleItems = includeActiveWorkspaceFamily({
    roots,
    visibleItems: window.visibleItems,
    tree,
    activeWorkspaceKey,
  });
  return { ...window, visibleItems, itemsByKey };
}
