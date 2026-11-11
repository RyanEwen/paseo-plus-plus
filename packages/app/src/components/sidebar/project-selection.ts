import type { WorkspaceStructureProject } from "@/projects/workspace-structure";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { selectWorkspaceStructureProjects } from "@/stores/session-store-hooks/selectors";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import { resolveActiveProjectFilters } from "./sidebar-project-filter";

/**
 * Keep an explicit project selection while revealing a successful Add Project result.
 *
 * Returns the stored list unchanged (same reference) when no available project is selected,
 * when the created project is not in `projects`, or when it is already selected.
 */
export function includeCreatedProjectFilter(input: {
  projectFilters: string[];
  projects: readonly Pick<WorkspaceStructureProject, "viewKey" | "hosts">[];
  serverId: string;
  projectId: string;
}): string[] {
  const { projectFilters, projects, serverId, projectId } = input;
  const available = new Set(projects.map((project) => project.viewKey));
  if (resolveActiveProjectFilters(projectFilters, available).length === 0) return projectFilters;
  const created = projects.find((project) =>
    project.hosts.some((host) => host.serverId === serverId && host.projectId === projectId),
  );
  if (!created || projectFilters.includes(created.viewKey)) return projectFilters;
  return [...projectFilters, created.viewKey];
}

/**
 * Add a project just created through Add Project to the sidebar's current project selection,
 * so a narrowed sidebar shows it. Reads the projects on the hosts the sidebar currently shows:
 * the selected hosts, or every host when none is selected.
 */
export function revealCreatedProjectInSidebar(input: {
  serverId: string;
  projectId: string;
}): void {
  const sidebar = useSidebarViewStore.getState();
  const allHostIds = getHostRuntimeStore()
    .getHosts()
    .map((candidate) => candidate.serverId);
  const selectedHostIds = allHostIds.filter((id) => sidebar.hostFilters.includes(id));
  const visibleHostIds = selectedHostIds.length > 0 ? selectedHostIds : allHostIds;
  const projects = selectWorkspaceStructureProjects(useSessionStore.getState(), visibleHostIds);
  sidebar.updateLocalFilters((current) => ({
    ...current,
    projectFilters: includeCreatedProjectFilter({
      projectFilters: current.projectFilters,
      projects,
      serverId: input.serverId,
      projectId: input.projectId,
    }),
  }));
}
