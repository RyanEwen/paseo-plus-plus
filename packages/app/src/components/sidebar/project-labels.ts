import type { WorkspaceStructureProject } from "@/projects/workspace-structure";
import type { HostProfile } from "@/types/host-connection";
import { hostDisplayLabel } from "@/hosts/display-label";

/** The project fields a chooser label reads. */
export type LabelledProject = Pick<
  WorkspaceStructureProject,
  "viewKey" | "projectName" | "hosts" | "iconWorkingDir"
>;

interface HostQualifiedLabel {
  viewKey: string;
  label: string;
  path: string;
}

/** Count how often each value occurs. */
function countValues(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

/**
 * Label each project for the chooser, keyed by view key. Colliding project names are qualified
 * with their hosts' names; labels that still collide (same name on the same hosts) also get the
 * project path.
 */
export function resolveSidebarProjectLabels(
  projects: readonly LabelledProject[],
  hosts: readonly Pick<HostProfile, "serverId" | "label">[],
): ReadonlyMap<string, string> {
  const hostLabels = new Map(hosts.map((host) => [host.serverId, hostDisplayLabel(host)]));
  const nameCounts = countValues(projects.map((project) => project.projectName));

  // First pass: qualify colliding names by host.
  const hostQualified = projects.map((project): HostQualifiedLabel => {
    const nameCollides = (nameCounts.get(project.projectName) ?? 0) > 1;
    if (!nameCollides) {
      return { viewKey: project.viewKey, label: project.projectName, path: project.iconWorkingDir };
    }
    const qualifier = project.hosts
      .map((host) => hostLabels.get(host.serverId) ?? host.serverId)
      .join(", ");
    return {
      viewKey: project.viewKey,
      label: `${project.projectName} (${qualifier})`,
      path: project.iconWorkingDir,
    };
  });

  // Second pass: labels that still collide name the project's path.
  const labelCounts = countValues(hostQualified.map((entry) => entry.label));
  return new Map(
    hostQualified.map((entry) => {
      const stillCollides = (labelCounts.get(entry.label) ?? 0) > 1;
      const label = stillCollides ? `${entry.label} (${entry.path})` : entry.label;
      return [entry.viewKey, label];
    }),
  );
}
