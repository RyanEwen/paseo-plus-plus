import type { ArchivedWorkspaceSummary } from "@getpaseo/protocol/messages";
import {
  resolveWorkspaceDisplayName,
  type ProjectRegistry,
  type WorkspaceRegistry,
} from "../../workspace-registry.js";
import { registerForkCapability } from "../../fork-capabilities.js";

// Hosts that load this module answer project-scoped archived workspace listings.
registerForkCapability("projectArchivedWorkspaces");

/** The requested project is missing or archived on this host. */
export class ProjectUnavailableError extends Error {
  constructor(readonly projectId: string) {
    super(`Project ${projectId} is not active on this host`);
    this.name = "ProjectUnavailableError";
  }
}

/** Read archived records for one active project without inspecting Git or reviving agents. */
export async function listArchivedProjectWorkspaces(input: {
  projectId: string;
  includeBackground?: boolean;
  projects: Pick<ProjectRegistry, "get">;
  workspaces: Pick<WorkspaceRegistry, "list">;
}): Promise<ArchivedWorkspaceSummary[]> {
  const project = await input.projects.get(input.projectId);
  if (!project || project.archivedAt) {
    throw new ProjectUnavailableError(input.projectId);
  }

  const entries: ArchivedWorkspaceSummary[] = [];
  for (const workspace of await input.workspaces.list()) {
    if (workspace.projectId !== input.projectId || !workspace.archivedAt) {
      continue;
    }
    if (workspace.background && !input.includeBackground) {
      continue;
    }
    entries.push({
      workspaceId: workspace.workspaceId,
      workspaceName: resolveWorkspaceDisplayName(workspace),
      workspaceDirectory: workspace.cwd,
      branch: workspace.branch,
      archivedAt: workspace.archivedAt,
    });
  }
  return entries.sort(
    (left, right) =>
      right.archivedAt.localeCompare(left.archivedAt) ||
      left.workspaceId.localeCompare(right.workspaceId),
  );
}
