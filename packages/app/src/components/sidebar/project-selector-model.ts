import type { TFunction } from "i18next";
import { createProjectIconTarget, type ProjectIconTarget } from "@/projects/icon-target";
import type { WorkspaceStructureProject } from "@/projects/workspace-structure";

/**
 * Icon requests for chooser rows, built from catalog projects. Each project uses its first
 * placement that names a server and an icon directory, like the sidebar's project rows.
 */
export function resolveProjectIconTargets(
  projects: readonly Pick<WorkspaceStructureProject, "viewKey" | "hosts">[],
): ProjectIconTarget[] {
  return projects.flatMap((project) => {
    const placement = project.hosts.find(
      (host) => host.serverId !== "" && host.iconWorkingDir.trim() !== "",
    );
    if (!placement) return [];
    const target = createProjectIconTarget({ projectViewKey: project.viewKey, placement });
    return target ? [target] : [];
  });
}

/**
 * The chooser trigger's text: All Workspaces, the one selected project's label, or a count of
 * selected projects. `resolvedProjectFilters` is the applied filter, not the stored one.
 */
export function resolveSelectorHeading(
  t: TFunction,
  resolvedProjectFilters: readonly string[],
  labels: ReadonlyMap<string, string>,
): string {
  if (resolvedProjectFilters.length === 1) {
    return t("sidebar.projectSelector.projectWorkspaces", {
      project: labels.get(resolvedProjectFilters[0]),
    });
  }
  if (resolvedProjectFilters.length > 1) {
    return t("sidebar.projectSelector.multipleWorkspaces", {
      count: resolvedProjectFilters.length,
    });
  }
  return t("sidebar.projectSelector.allWorkspaces");
}

/**
 * Whether the chooser's All row is checked: no project filter applies, and the host filter is
 * empty or names only hosts that are no longer registered.
 */
export function showsAllWorkspaces(input: {
  resolvedProjectFilters: readonly string[];
  hostFilters: readonly string[];
  serverIds: readonly string[];
}): boolean {
  if (input.resolvedProjectFilters.length > 0) return false;
  if (input.hostFilters.length === 0) return true;
  const hostFilterIsInert = !input.serverIds.some((id) => input.hostFilters.includes(id));
  return hostFilterIsInert;
}

/** Catalog projects placed on at least one selected host, or every project with no host filter. */
export function projectsOnVisibleHosts<T extends Pick<WorkspaceStructureProject, "hosts">>(
  projects: readonly T[],
  hostFilters: readonly string[],
): T[] {
  if (hostFilters.length === 0) return [...projects];
  return projects.filter((project) =>
    project.hosts.some((host) => hostFilters.includes(host.serverId)),
  );
}

/** Whether the Hosts branch carries the active-filter dot. */
export function hostBranchIsActive(input: {
  hostFilters: readonly string[];
  projectFilters: readonly string[];
}): boolean {
  return input.hostFilters.length > 0 || input.projectFilters.length > 0;
}
