import type { ArchivedWorkspaceSummary } from "@getpaseo/protocol/messages";
import {
  resolveWorkspaceDisplayName,
  type ProjectRegistry,
  type WorkspaceRegistry,
} from "../../workspace-registry.js";

/** Read archived records for one active project without inspecting Git or reviving agents. */
export async function listArchivedProjectWorkspaces(input: {
  projectId: string;
  includeBackground?: boolean;
  projects: Pick<ProjectRegistry, "get">;
  workspaces: Pick<WorkspaceRegistry, "list">;
}): Promise<ArchivedWorkspaceSummary[]> {
  const project = await input.projects.get(input.projectId);
  if (!project || project.archivedAt) {
    throw new Error("The project no longer exists on this host.");
  }

  const workspaces = await input.workspaces.list();
  return workspaces
    .filter(
      (workspace) =>
        workspace.projectId === input.projectId &&
        workspace.archivedAt &&
        (input.includeBackground || !workspace.background),
    )
    .map((workspace) => ({
      workspaceId: workspace.workspaceId,
      workspaceName: resolveWorkspaceDisplayName(workspace),
      workspaceDirectory: workspace.cwd,
      branch: workspace.branch,
      archivedAt: workspace.archivedAt!,
    }))
    .sort(
      (left, right) =>
        right.archivedAt.localeCompare(left.archivedAt) ||
        left.workspaceId.localeCompare(right.workspaceId),
    );
}
