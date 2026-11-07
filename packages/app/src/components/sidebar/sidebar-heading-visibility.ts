import type { SidebarGroupMode } from "@/stores/sidebar-view-store";

/** What the workspace list knows about its own contents when it decides whether to show its heading. */
export interface SidebarHeadingVisibilityInput {
  groupMode: SidebarGroupMode;
  /** Projects listed below the heading in project mode (after pins and empty-project grouping). */
  unpinnedProjectCount: number;
  pinnedWorkspaceCount: number;
  /** Projects without workspaces. */
  emptyProjectCount: number;
  /** Whether project mode shows projects without workspaces in their own group. */
  groupsEmptyProjects: boolean;
  hasActiveHostFilter: boolean;
  hasActiveProjectFilter: boolean;
  /** A local filter matched nothing in an otherwise populated sidebar. */
  sidebarFilterEmpty: boolean;
}

/**
 * Decide whether the list shows the Workspaces heading (project selector and display controls).
 *
 * The heading carries the display menu, which is the only way back out of a filter, so it stays
 * for as long as a filter is what emptied the list. In project mode it is absent only when the
 * sidebar is genuinely empty, where a heading would sit over the empty state. Every filter that
 * can empty project mode needs a term here: a project filter pinned to a project whose workspaces
 * are all pinned leaves no unpinned projects, and without the pin term the heading would go with
 * it. Grouped (status) mode always shows it, as upstream does.
 */
export function shouldShowSidebarHeading(input: SidebarHeadingVisibilityInput): boolean {
  if (input.groupMode !== "project") {
    return true;
  }

  return (
    input.unpinnedProjectCount > 0 ||
    input.pinnedWorkspaceCount > 0 ||
    (input.groupsEmptyProjects && input.emptyProjectCount > 0) ||
    input.hasActiveHostFilter ||
    input.hasActiveProjectFilter ||
    input.sidebarFilterEmpty
  );
}
