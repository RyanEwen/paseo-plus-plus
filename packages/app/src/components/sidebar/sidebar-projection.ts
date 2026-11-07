import {
  effectiveWorkspaceCollapse,
  expandedWorkspaceRows,
  orderWorkspaceFamilies,
  workspaceFamilyRoots,
  type WorkspaceTreeNode,
} from "./workspace-tree";
import type { WorkspaceTitleSource } from "@/hooks/use-settings";
import type { TFunction } from "i18next";
import { buildStatusGroups } from "@/hooks/sidebar-status-view-model";
import {
  splitPinnedSidebarGroups,
  type PinnedSidebarGroups,
  type PinnedSidebarKeys,
} from "@/hooks/use-sidebar-pins";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import { arrangeProjectPinnedWorkspaces } from "./project-pins";
import { arrangeSidebarWorkspaces } from "./sidebar-arrangement";
import type { SidebarWorkspaceSortMode, SidebarGroupMode } from "@/stores/sidebar-view-store";
import {
  resolveSidebarProjectIconTargets,
  type SidebarProjectIconTarget,
} from "@/utils/sidebar-project-row-model";
import {
  buildSidebarShortcutSections,
  type SidebarShortcutModel,
  type SidebarShortcutSection,
} from "@/utils/sidebar-shortcuts";
import { statusWorkspaceGroups, type SidebarWorkspaceGroup } from "./sidebar-labels";

export interface SidebarProjection {
  pinnedGroups: PinnedSidebarGroups;
  workspaceGroups: SidebarWorkspaceGroup[];
  /**
   * The project icons this projection needs fetched, keyed by `projectViewKey` — one per project,
   * whatever the mode groups by. It sits here rather than beside `useProjectIcons` in the list
   * because it is the same `projects` the rows above are projected from: a mode that renders a
   * row can only ever ask for an icon this list already covers. It used to be derived in the
   * list, under a `groupMode === "status"` gate written when status was the only mode that put
   * icons on rows.
   */
  projectIconTargets: SidebarProjectIconTarget[];
  shortcutModel: SidebarShortcutModel;
  workspaceTree: ReadonlyMap<string, WorkspaceTreeNode>;
  effectiveCollapsedWorkspaceKeys: ReadonlySet<string>;
}

export interface SidebarProjectionInput {
  projects: SidebarProjectEntry[];
  workspaceParents?: ReadonlyMap<string, string>;
  activeWorkspaceKey?: string | null;
  pinnedKeys: PinnedSidebarKeys;
  pinnedWorkspaceOrder: string[];
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  projectNamesByViewKey: Map<string, string>;
  groupMode: SidebarGroupMode;
  workspaceSortMode: SidebarWorkspaceSortMode;
  projectPinningEnabled: boolean;
  workspaceTitleSource: WorkspaceTitleSource;
  statusWorkspaceOrder: string[];
  pinnedCollapsed: boolean;
  collapsedProjectKeys: ReadonlySet<string>;
  collapsedWorkspaceGroupKeys: ReadonlySet<string>;
  t: TFunction;
}

/** Project visible rows and keyboard shortcuts from the same sorting and pinning decisions. */
export function buildSidebarProjection(input: SidebarProjectionInput): SidebarProjection {
  const pinnedGroups = splitPinnedSidebarGroups({
    projects: input.projects,
    keys: input.pinnedKeys,
    pinnedWorkspaceOrder: input.pinnedWorkspaceOrder,
  });
  if (input.groupMode === "project") {
    pinnedGroups.unpinnedProjects = pinnedGroups.unpinnedProjects.map((project) => ({
      ...project,
      workspaces: arrangeProjectPinnedWorkspaces({
        workspaces: arrangeSidebarWorkspaces({
          workspaces: project.workspaces,
          mode: input.workspaceSortMode,
          entries: input.workspaceEntriesByKey,
          workspaceTitleSource: input.workspaceTitleSource,
        }),
        entriesByKey: input.workspaceEntriesByKey,
        enabled: input.projectPinningEnabled,
        storedPinOrder: input.pinnedWorkspaceOrder,
      }),
    }));
  }
  const parents = input.workspaceParents ?? new Map<string, string>();
  const tree = new Map<string, WorkspaceTreeNode>();
  const pinned = orderWorkspaceFamilies({ workspaces: pinnedGroups.pinnedChats, parents });
  pinnedGroups.pinnedChats = pinned.rows;
  for (const [key, node] of pinned.tree) tree.set(key, node);
  if (input.groupMode === "project") {
    pinnedGroups.unpinnedProjects = pinnedGroups.unpinnedProjects.map((project) => {
      const family = orderWorkspaceFamilies({ workspaces: project.workspaces, parents });
      for (const [key, node] of family.tree) tree.set(key, node);
      return { ...project, workspaces: family.rows };
    });
  }
  const pinnedWorkspaceKeys = new Set(input.pinnedKeys.pinnedWorkspaceKeys);
  const unpinnedWorkspaces = Array.from(input.workspaceEntriesByKey.values()).filter(
    (workspace) => !pinnedWorkspaceKeys.has(workspace.workspaceKey),
  );
  // One switch decides both what the list groups by and what the keyboard shortcuts walk, so the
  // two cannot disagree and a new grouping mode is a compile error here rather than a silent
  // fall-through to the project rows.
  let workspaceGroups = buildWorkspaceGroups(input, unpinnedWorkspaces);
  if (input.groupMode === "status") {
    let members = workspaceGroups.flatMap((group) => group.rows);
    if (input.workspaceSortMode === "custom") {
      const ranks = new Map(
        [
          ...new Set([
            ...input.statusWorkspaceOrder,
            ...input.projects.flatMap((project) =>
              project.workspaces.map((workspace) => workspace.workspaceKey),
            ),
          ]),
        ].map((key, index) => [key, index]),
      );
      members = [...members].sort(
        (a, b) => ranks.get(a.workspaceKey)! - ranks.get(b.workspaceKey)!,
      );
    } else {
      members = arrangeSidebarWorkspaces({
        workspaces: members,
        mode: input.workspaceSortMode,
        entries: input.workspaceEntriesByKey,
        workspaceTitleSource: input.workspaceTitleSource,
      });
    }
    const family = orderWorkspaceFamilies({ workspaces: members, parents });
    for (const [key, node] of family.tree) tree.set(key, node);
    const entries = new Map(family.rows.map((row) => [row.workspaceKey, row]));
    workspaceGroups = workspaceGroups.flatMap((group) => {
      const roots = workspaceFamilyRoots(group.rows, family.tree);
      const rows: SidebarWorkspaceEntry[] = [];
      for (const root of roots) {
        rows.push(root);
        for (const key of family.tree.get(root.workspaceKey)!.descendantKeys) {
          rows.push(entries.get(key)!);
        }
      }
      return rows.length > 0 ? [{ ...group, rows }] : [];
    });
  }
  const collapsed = effectiveWorkspaceCollapse({
    tree,
    collapsedKeys: input.collapsedWorkspaceGroupKeys,
    activeWorkspaceKey: input.activeWorkspaceKey ?? null,
  });
  const shortcutRows = (workspaces: readonly SidebarWorkspacePlacement[]) =>
    expandedWorkspaceRows({ workspaces, tree, collapsedKeys: collapsed });

  const sections: SidebarShortcutSection[] = [];
  if (!input.pinnedCollapsed) {
    sections.push({ workspaces: shortcutRows(pinnedGroups.pinnedChats) });
  }
  if (input.groupMode === "project") {
    sections.push(
      ...pinnedGroups.unpinnedProjects.map((project) => ({
        workspaces: shortcutRows(project.workspaces),
        collapsed: input.collapsedProjectKeys.has(project.viewKey),
      })),
    );
  } else {
    sections.push(
      ...workspaceGroups.map((group) => ({
        workspaces: shortcutRows(group.rows),
        collapsed: input.collapsedWorkspaceGroupKeys.has(group.key),
      })),
    );
  }

  return {
    pinnedGroups,
    workspaceGroups,
    workspaceTree: tree,
    effectiveCollapsedWorkspaceKeys: collapsed,
    projectIconTargets: resolveSidebarProjectIconTargets(input.projects),
    shortcutModel: buildSidebarShortcutSections({ sections }),
  };
}

/** Project mode keeps its project headers and groups nothing; status mode groups the rows. */
function buildWorkspaceGroups(
  input: SidebarProjectionInput,
  unpinnedWorkspaces: SidebarWorkspaceEntry[],
): SidebarWorkspaceGroup[] {
  switch (input.groupMode) {
    case "project":
      return [];
    case "status": {
      const groups = statusWorkspaceGroups(
        buildStatusGroups(unpinnedWorkspaces, input.projectNamesByViewKey, input.t),
      );
      const mode = input.workspaceSortMode;
      if (mode === "status") return groups;
      const customKeys = input.statusWorkspaceOrder;
      const fallbackKeys = input.projects.flatMap((project) =>
        project.workspaces.map((workspace) => workspace.workspaceKey),
      );
      const ranks = new Map(
        [...new Set([...customKeys, ...fallbackKeys])].map((key, index) => [key, index]),
      );
      return groups.map((group) => {
        const rows = [...group.rows].sort(
          (a, b) => ranks.get(a.workspaceKey)! - ranks.get(b.workspaceKey)!,
        );
        group.rows = arrangeSidebarWorkspaces({
          workspaces: rows,
          mode,
          entries: input.workspaceEntriesByKey,
          workspaceTitleSource: input.workspaceTitleSource,
        });
        return group;
      });
    }
  }
}
