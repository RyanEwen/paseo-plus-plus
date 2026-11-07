import type { SidebarCollapseTargets } from "@/stores/sidebar-collapsed-sections-store/state";
import type { SidebarProjection, SidebarProjectionInput } from "./sidebar-projection";
import { EMPTY_WORKSPACE_TREE, workspaceCollapseKey, type WorkspaceTreeNode } from "./workspace-tree";

/** The filtered projection the sidebar renders, plus the Empty projects grouping preference. */
export interface SidebarCollapseTargetsInput
  extends
    Pick<SidebarProjectionInput, "projects" | "groupMode">,
    Pick<SidebarProjection, "pinnedGroups" | "workspaceGroups"> {
  groupEmptyProjects: boolean;
  /** Rendered workspace families; every parent with children is a collapse target. */
  workspaceTree?: ReadonlyMap<string, WorkspaceTreeNode>;
}

/**
 * Resolve bulk collapse targets from the same filtered projection that renders the sidebar:
 * project headers, Status groups, the Empty projects group, the Pinned section and workspace
 * families. Sections the
 * current filters hide are not targets, so their saved collapse state survives Expand all and
 * Collapse all.
 */
export function resolveSidebarCollapseTargets(
  input: SidebarCollapseTargetsInput,
): SidebarCollapseTargets {
  // Global pinning removes child rows from project sections, but it does not make the
  // original project empty. Empty-section headers are rendered from the filtered originals.
  const emptyProjects = input.projects.filter((project) => project.workspaces.length === 0);
  const renderedProjects =
    input.groupMode === "project" ? input.pinnedGroups.unpinnedProjects : emptyProjects;
  const workspaceGroupKeys =
    input.groupMode === "status" ? input.workspaceGroups.map((group) => group.key) : [];
  if (input.groupEmptyProjects && emptyProjects.length > 0) {
    workspaceGroupKeys.push("no-unarchived-workspaces");
  }
  for (const [key, node] of input.workspaceTree ?? EMPTY_WORKSPACE_TREE) {
    if (node.childKeys.length > 0) workspaceGroupKeys.push(workspaceCollapseKey(key));
  }
  return {
    projectKeys: renderedProjects.map((project) => project.viewKey),
    workspaceGroupKeys,
    includePinned: input.pinnedGroups.pinnedChats.length > 0,
  };
}
