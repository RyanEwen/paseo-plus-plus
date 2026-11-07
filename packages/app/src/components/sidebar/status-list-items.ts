import {
  EMPTY_WORKSPACE_TREE,
  collectActiveWorkspaceKeys,
  includeActiveWorkspaceFamily,
  indexByWorkspaceKey,
  workspaceFamilyRoots,
  workspaceFamilyUpdatedAt,
  type WorkspaceTreeNode,
} from "./workspace-tree";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { SidebarWorkspaceGroup } from "./sidebar-labels";
import { limitSidebarWorkspaces } from "./workspace-limit";
import type { DragReorderMove } from "@/components/drag-reorder/reorder-items";
import { hasVisibleOrderChanged } from "@/utils/sidebar-reorder";

/** One cell of the flat status list: a group header, a workspace row or a group's Show more footer. */
export type StatusListItem =
  | { kind: "header"; group: SidebarWorkspaceGroup; collapsed: boolean }
  | { kind: "workspace"; workspace: SidebarWorkspaceEntry; groupKey: string }
  | { kind: "footer"; groupKey: string; expanded: boolean; canToggle: boolean };

/** Keep workspace keys independent of their status group so moves retain their React subtree. */
export function statusListItemKey(item: StatusListItem): string {
  if (item.kind === "header") return `header:${item.group.key}`;
  if (item.kind === "footer") return `footer:${item.groupKey}`;
  return `workspace:${item.workspace.workspaceKey}`;
}

/** Structural entries never initiate a drag or become an allowed drop target. */
export function statusListDragGroupKey(item: StatusListItem): string | null {
  return item.kind === "workspace" ? item.groupKey : null;
}

/** Flatten visible groups under one cell owner without changing collapse or limit policy. */
export function buildStatusListItems({
  groups,
  collapsedGroupKeys,
  expandedGroupKeys,
  initialCount,
  updatedWithin,
  keep,
  workspaceTree = EMPTY_WORKSPACE_TREE,
  activeWorkspaceKey = null,
}: {
  groups: SidebarWorkspaceGroup[];
  workspaceTree?: ReadonlyMap<string, WorkspaceTreeNode>;
  activeWorkspaceKey?: string | null;
  collapsedGroupKeys: ReadonlySet<string>;
  expandedGroupKeys: ReadonlySet<string>;
  initialCount: number | null;
  updatedWithin?: { days: number; now: number };
  /** Rows that stay visible past a group's count and age windows, such as the open workspace. */
  keep?: (workspace: SidebarWorkspaceEntry) => boolean;
}): StatusListItem[] {
  const result: StatusListItem[] = [];
  for (const group of groups) {
    const collapsed = collapsedGroupKeys.has(group.key);
    result.push({ kind: "header", group, collapsed });
    if (collapsed) continue;
    const expanded = expandedGroupKeys.has(group.key);
    const entries = indexByWorkspaceKey(group.rows);
    const roots = workspaceFamilyRoots(group.rows, workspaceTree);
    const { visibleItems, canToggle } = limitSidebarWorkspaces({
      items: roots,
      initialCount,
      expanded,
      updatedWithin: updatedWithin
        ? {
            ...updatedWithin,
            getStatusEnteredAt: (workspace) =>
              workspaceFamilyUpdatedAt({
                workspaceKey: workspace.workspaceKey,
                tree: workspaceTree,
                getStatusEnteredAt: (key) => entries.get(key)?.statusEnteredAt ?? null,
              }),
          }
        : undefined,
      keep,
    });
    const rendered = includeActiveWorkspaceFamily({
      roots,
      visibleItems,
      tree: workspaceTree,
      activeWorkspaceKey,
      activeWorkspaceKeys: collectActiveWorkspaceKeys(entries),
    });
    for (const workspace of rendered) {
      result.push({ kind: "workspace", workspace, groupKey: group.key });
    }
    result.push({
      kind: "footer",
      groupKey: group.key,
      expanded,
      canToggle: canToggle && (expanded || rendered.length < roots.length),
    });
  }
  return result;
}

/** Workspace keys of one status group's rows, in list order. */
function workspaceKeysInGroup(items: readonly StatusListItem[], groupKey: string): string[] {
  return items.flatMap((item) =>
    item.kind === "workspace" && item.groupKey === groupKey ? [item.workspace.workspaceKey] : [],
  );
}

/**
 * The moved row's group order after a drop, or null when that order did not change.
 *
 * The list confines drags to one group, so only the moved row's group can differ; headers,
 * footers and other groups keep their positions.
 */
export function resolveStatusGroupReorder({
  items,
  reordered,
  move,
}: {
  items: readonly StatusListItem[];
  reordered: readonly StatusListItem[];
  move: DragReorderMove;
}): string[] | null {
  const moved = items.find((item) => statusListItemKey(item) === move.activeKey);
  if (moved?.kind !== "workspace") return null;
  const currentOrder = workspaceKeysInGroup(items, moved.groupKey);
  const reorderedVisibleKeys = workspaceKeysInGroup(reordered, moved.groupKey);
  if (!hasVisibleOrderChanged({ currentOrder, reorderedVisibleKeys })) return null;
  return reorderedVisibleKeys;
}
