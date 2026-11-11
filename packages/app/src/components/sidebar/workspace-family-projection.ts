import type { PinnedSidebarGroups } from "@/hooks/use-sidebar-pins";
import type {
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import { arrangeSidebarWorkspaces } from "./sidebar-arrangement";
import type { SidebarWorkspaceGroup } from "./sidebar-labels";
import type { SidebarProjectionInput } from "./sidebar-projection";
import {
  effectiveWorkspaceCollapse,
  expandedWorkspaceRows,
  indexByWorkspaceKey,
  orderWorkspaceFamilies,
  workspaceFamilyRoots,
  type WorkspaceTreeNode,
} from "./workspace-tree";

type WorkspaceTree = Map<string, WorkspaceTreeNode>;

/** The sidebar projection's sections with workspace families nested under their parents. */
export interface SidebarFamilyProjection {
  pinnedGroups: PinnedSidebarGroups;
  workspaceGroups: SidebarWorkspaceGroup[];
  workspaceTree: ReadonlyMap<string, WorkspaceTreeNode>;
  /** Saved collapse choices plus every collapsed parent above the active workspace, reopened. */
  effectiveCollapsedWorkspaceKeys: ReadonlySet<string>;
  /** The rows a section shows for keyboard shortcuts: collapsed families contribute their parent. */
  shortcutRows: (workspaces: readonly SidebarWorkspacePlacement[]) => SidebarWorkspacePlacement[];
}

/**
 * Nest workspace families inside the already sorted Pinned, Project and Status sections.
 *
 * Pinned and project sections keep their boundaries: a family only forms inside one section.
 * Status view orders every unpinned member once with the view's sort, nests families, then puts
 * each family root back in its own status group with its descendants after it, so children follow
 * their parent while keeping their own status.
 */
export function projectWorkspaceFamilies(input: {
  projection: SidebarProjectionInput;
  pinnedGroups: PinnedSidebarGroups;
  workspaceGroups: SidebarWorkspaceGroup[];
}): SidebarFamilyProjection {
  const { projection } = input;
  const parents = projection.workspaceParents ?? new Map<string, string>();
  const tree: WorkspaceTree = new Map();
  const pinnedGroups = nestPinnedAndProjectFamilies({
    pinnedGroups: input.pinnedGroups,
    groupMode: projection.groupMode,
    parents,
    tree,
  });
  const workspaceGroups =
    projection.groupMode === "status"
      ? nestStatusGroupFamilies({ projection, groups: input.workspaceGroups, parents, tree })
      : input.workspaceGroups;
  const collapsed = effectiveWorkspaceCollapse({
    tree,
    collapsedKeys: projection.collapsedWorkspaceGroupKeys,
    activeWorkspaceKey: projection.activeWorkspaceKey ?? null,
  });
  return {
    pinnedGroups,
    workspaceGroups,
    workspaceTree: tree,
    effectiveCollapsedWorkspaceKeys: collapsed,
    shortcutRows: (workspaces) =>
      expandedWorkspaceRows({ workspaces, tree, collapsedKeys: collapsed }),
  };
}

/** Order families inside the Pinned section and, in Project view, inside each project. */
function nestPinnedAndProjectFamilies(input: {
  pinnedGroups: PinnedSidebarGroups;
  groupMode: SidebarProjectionInput["groupMode"];
  parents: ReadonlyMap<string, string>;
  tree: WorkspaceTree;
}): PinnedSidebarGroups {
  const { parents, tree } = input;
  const pinned = orderWorkspaceFamilies({ workspaces: input.pinnedGroups.pinnedChats, parents });
  mergeTree(tree, pinned.tree);
  if (input.groupMode !== "project") {
    return Object.assign({}, input.pinnedGroups, { pinnedChats: pinned.rows });
  }
  const unpinnedProjects = input.pinnedGroups.unpinnedProjects.map((project) => {
    const family = orderWorkspaceFamilies({ workspaces: project.workspaces, parents });
    mergeTree(tree, family.tree);
    return Object.assign({}, project, { workspaces: family.rows });
  });
  return Object.assign({}, input.pinnedGroups, { pinnedChats: pinned.rows, unpinnedProjects });
}

/**
 * Status view: rank every member with the view's sort, nest families, and regroup by each root's
 * status. A group whose members all became children of a root in another group disappears,
 * because those children render with their parent.
 */
function nestStatusGroupFamilies(input: {
  projection: SidebarProjectionInput;
  groups: SidebarWorkspaceGroup[];
  parents: ReadonlyMap<string, string>;
  tree: WorkspaceTree;
}): SidebarWorkspaceGroup[] {
  const members = rankStatusMembers(
    input.projection,
    input.groups.flatMap((group) => group.rows),
  );
  const family = orderWorkspaceFamilies({ workspaces: members, parents: input.parents });
  mergeTree(input.tree, family.tree);
  const entries = indexByWorkspaceKey(family.rows);
  return input.groups.flatMap((group) => {
    const rows: SidebarWorkspaceEntry[] = [];
    for (const root of workspaceFamilyRoots(group.rows, family.tree)) {
      rows.push(root);
      for (const key of family.tree.get(root.workspaceKey)!.descendantKeys) {
        rows.push(entries.get(key)!);
      }
    }
    return rows.length > 0 ? [Object.assign({}, group, { rows })] : [];
  });
}

/**
 * Order status members across groups so a family's members are ranked together: Custom sorting
 * follows the saved status order with project order as the fallback; other sorts use the
 * sidebar's arrangement.
 */
function rankStatusMembers(
  projection: SidebarProjectionInput,
  members: SidebarWorkspaceEntry[],
): SidebarWorkspaceEntry[] {
  if (projection.workspaceSortMode !== "custom") {
    return arrangeSidebarWorkspaces({
      workspaces: members,
      mode: projection.workspaceSortMode,
      entries: projection.workspaceEntriesByKey,
      workspaceTitleSource: projection.workspaceTitleSource,
    });
  }
  const fallbackKeys = projection.projects.flatMap((project) =>
    project.workspaces.map((workspace) => workspace.workspaceKey),
  );
  const ranks = new Map(
    [...new Set([...projection.statusWorkspaceOrder, ...fallbackKeys])].map((key, index) => [
      key,
      index,
    ]),
  );
  return [...members].sort((a, b) => ranks.get(a.workspaceKey)! - ranks.get(b.workspaceKey)!);
}

/** Copy one section's family nodes into the projection-wide tree. */
function mergeTree(target: WorkspaceTree, source: ReadonlyMap<string, WorkspaceTreeNode>): void {
  for (const [key, node] of source) target.set(key, node);
}
