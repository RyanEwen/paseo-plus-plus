import type { AgentSnapshotPayload, WorkspaceRecoveryState } from "@getpaseo/protocol/messages";
import { i18n } from "@/i18n/i18next";
import {
  listUnarchivedProjectAgents,
  type ProjectArchiveDiscoveryClient,
} from "./project-archive-discovery";
import type { ProjectArchiveWorkspace } from "./project-workspace-archive";

interface ArchiveAgentResult {
  agent: Pick<AgentSnapshotPayload, "id" | "workspaceId" | "archivedAt" | "status">;
}

export interface ProjectArchiveVerificationClient extends Pick<
  ProjectArchiveDiscoveryClient,
  "fetchAgentHistory"
> {
  inspectWorkspaceRecovery: (workspaceId: string) => Promise<WorkspaceRecoveryState>;
  fetchAgent: (agentId: string) => Promise<ArchiveAgentResult | null>;
}

/**
 * Verify durable archive state, not a missing sidebar row or RPC acknowledgement.
 * Exact agent reads additionally require archived, non-running state for every confirmed identity.
 * Stored snapshots retain idle/error status after archive; status does not prove runtime residency.
 * Directory removal is intentionally best-effort in the canonical archive service.
 */
export async function verifyProjectWorkspaceArchive(input: {
  client: ProjectArchiveVerificationClient;
  workspace: ProjectArchiveWorkspace;
}): Promise<void> {
  const recovery = await input.client.inspectWorkspaceRecovery(input.workspace.workspaceId);
  if (recovery.kind !== "recoverable") {
    throw new Error(
      i18n.t("sidebar.project.archive.verificationFailed", { workspace: input.workspace.name }),
    );
  }

  const remaining = await listUnarchivedProjectAgents(input.client, input.workspace.workspaceId);
  if (remaining.some((agent) => agent.workspaceId === input.workspace.workspaceId)) {
    throw new Error(
      i18n.t("sidebar.project.archive.agentsRemaining", { workspace: input.workspace.name }),
    );
  }

  for (const agentId of input.workspace.agentIds) {
    const result = await input.client.fetchAgent(agentId);
    if (
      !result ||
      result.agent.id !== agentId ||
      result.agent.workspaceId !== input.workspace.workspaceId ||
      !result.agent.archivedAt ||
      result.agent.status === "running" ||
      result.agent.status === "initializing"
    ) {
      throw new Error(i18n.t("sidebar.project.archive.agentNotArchived", { agent: agentId }));
    }
  }
}
