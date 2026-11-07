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
