import { confirmRiskyWorktreeArchive, toWorktreeArchiveRisk } from "@/git/worktree-archive-warning";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { WorkspaceArchiveTarget } from "@/workspace/workspace-archive";
import { i18n } from "@/i18n/i18next";
import type { ConfirmDialogInput } from "@/utils/confirm-dialog";

export interface ProjectWorkspaceArchiveEntry extends Pick<
  SidebarWorkspaceEntry,
  | "serverId"
  | "workspaceId"
  | "workspaceKind"
  | "name"
  | "archiveHasUncommittedChanges"
  | "archiveUnpushedCommitCount"
  | "diffStat"
> {}

type ConfirmWorktreeArchive = typeof confirmRiskyWorktreeArchive;

export interface ProjectArchiveWorkspace extends ProjectWorkspaceArchiveEntry {
  background: boolean;
  agentIds: string[];
  runningAgentCount: number;
}

export interface ProjectArchiveSelection {
  workspaces: ProjectArchiveWorkspace[];
  agentCount: number;
  runningAgentCount: number;
}

/** Share the counted warning between ordinary confirmations and the background opt-in sheet. */
export function buildProjectArchiveConfirmation(input: {
  projectName: string;
  hostCount: number;
  selection: ProjectArchiveSelection;
}): ConfirmDialogInput {
  return {
    title: i18n.t("sidebar.project.archive.title"),
    message: i18n.t("sidebar.project.archive.message", {
      projectName: input.projectName,
      hostCount: input.hostCount,
      workspaceCount: input.selection.workspaces.length,
      agentCount: input.selection.agentCount,
      runningAgentCount: input.selection.runningAgentCount,
    }),
    confirmLabel: i18n.t("sidebar.project.archive.action"),
    cancelLabel: i18n.t("common.actions.cancel"),
    destructive: true,
  };
}

export type ProjectArchiveOutcome =
  | { kind: "cancelled" | "changed" }
  | { kind: "archived"; archivedCount: number }
  | {
      kind: "failed";
      archivedCount: number;
      failed: ProjectArchiveWorkspace;
      unprocessedCount: number;
      error: unknown;
    };

/** Select background work only after an explicit opt-in, independently of sidebar visibility. */
export function selectProjectArchiveScope(
  workspaces: readonly ProjectArchiveWorkspace[],
  includeBackground: boolean,
): ProjectArchiveSelection {
  const selected = workspaces.filter((workspace) => includeBackground || !workspace.background);
  return {
    workspaces: selected,
    agentCount: selected.reduce((count, workspace) => count + workspace.agentIds.length, 0),
    runningAgentCount: selected.reduce(
      (count, workspace) => count + workspace.runningAgentCount,
      0,
    ),
  };
}

/** Ignore listing order while detecting changes to membership, running work, and archive risks. */
function archiveSelectionSignature(workspaces: readonly ProjectArchiveWorkspace[]): string {
  return JSON.stringify(
    workspaces
      .map((workspace) => ({
        ...workspace,
        agentIds: [...workspace.agentIds].sort(),
      }))
      .sort((left, right) =>
        JSON.stringify([left.serverId, left.workspaceId]).localeCompare(
          JSON.stringify([right.serverId, right.workspaceId]),
        ),
      ),
  );
}

/**
 * Confirm every risky worktree before any mutation, then archive serially.
 * A failure stops the batch so later targets retain their state and can be retried.
 */
export async function archiveProjectWorkspaces(input: {
  workspaces: ProjectArchiveWorkspace[];
  /** Return the explicit background choice, or null when the user cancels. */
  confirm: (workspaces: ProjectArchiveWorkspace[]) => Promise<boolean | null>;
  refresh: () => Promise<ProjectArchiveWorkspace[]>;
  archive: (workspace: ProjectArchiveWorkspace) => Promise<void>;
  onProgress: (completed: number, total: number) => void;
  confirmWorktreeArchive?: ConfirmWorktreeArchive;
}): Promise<ProjectArchiveOutcome> {
  const includeBackground = await input.confirm(input.workspaces);
  if (includeBackground === null) {
    return { kind: "cancelled" };
  }
  const selection = selectProjectArchiveScope(input.workspaces, includeBackground);

  const confirmed = await selectProjectWorkspacesToArchive(
    selection.workspaces,
    input.confirmWorktreeArchive,
  );
  if (confirmed.length !== selection.workspaces.length) {
    return { kind: "cancelled" };
  }

  // Confirmation can remain open while another client adds work or Git state changes.
  const refreshed = selectProjectArchiveScope(await input.refresh(), includeBackground);
  if (
    archiveSelectionSignature(selection.workspaces) !==
    archiveSelectionSignature(refreshed.workspaces)
  ) {
    return { kind: "changed" };
  }

  let archivedCount = 0;
  for (const workspace of selection.workspaces) {
    input.onProgress(archivedCount, selection.workspaces.length);
    try {
      await input.archive(workspace);
    } catch (error) {
      return {
        kind: "failed",
        archivedCount,
        failed: workspace,
        unprocessedCount: selection.workspaces.length - archivedCount - 1,
        error,
      };
    }
    archivedCount += 1;
  }

  input.onProgress(archivedCount, selection.workspaces.length);
  return { kind: "archived", archivedCount };
}

export async function selectProjectWorkspacesToArchive(
  workspaces: ProjectWorkspaceArchiveEntry[],
  confirmWorktreeArchive: ConfirmWorktreeArchive = confirmRiskyWorktreeArchive,
): Promise<WorkspaceArchiveTarget[]> {
  const confirmed: WorkspaceArchiveTarget[] = [];

  for (const workspace of workspaces) {
    if (workspace.workspaceKind === "worktree") {
      const shouldArchive = await confirmWorktreeArchive({
        workspaceName: workspace.name,
        ...toWorktreeArchiveRisk(workspace),
      });
      if (!shouldArchive) {
        continue;
      }
    }

    confirmed.push({
      serverId: workspace.serverId,
      workspaceId: workspace.workspaceId,
    });
  }

  return confirmed;
}
