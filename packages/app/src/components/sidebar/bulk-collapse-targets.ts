import type { SidebarCollapseTargets } from "@/stores/sidebar-collapsed-sections-store/state";
import type { SidebarProjection, SidebarProjectionInput } from "./sidebar-projection";

/** The filtered projection the sidebar renders, plus the Empty projects grouping preference. */
export interface SidebarCollapseTargetsInput
  extends
    Pick<SidebarProjectionInput, "projects" | "groupMode">,
    Pick<SidebarProjection, "pinnedGroups" | "workspaceGroups"> {
  groupEmptyProjects: boolean;
}

/**
 * Resolve bulk collapse targets from the same filtered projection that renders the sidebar:
 * project headers, Status groups, the Empty projects group and the Pinned section. Sections the
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
  return {
    projectKeys: renderedProjects.map((project) => project.viewKey),
    workspaceGroupKeys,
    includePinned: input.pinnedGroups.pinnedChats.length > 0,
  };
}
