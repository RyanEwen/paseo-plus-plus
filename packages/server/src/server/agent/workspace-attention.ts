import {
  NotificationReceipts,
  type NotificationAcknowledgement,
} from "@getpaseo/protocol/notification-receipts";
import type { AgentSnapshotPayload } from "../messages.js";
import type { PersistedWorkspaceRecord } from "../workspace-registry.js";
import type { AgentManager } from "./agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent-storage.js";

interface WorkspaceAttentionDependencies {
  manager: Pick<AgentManager, "getAgent" | "clearAgentAttention">;
  storage: Pick<AgentStorage, "get" | "upsert" | "clearAttentionIfUnchanged">;
  publishStored(record: StoredAgentRecord, workspaceId: string): Promise<void>;
}

interface WorkspaceAttentionClearInput {
  workspace: PersistedWorkspaceRecord;
  agents: readonly AgentSnapshotPayload[];
  notification?: NotificationAcknowledgement;
  onCleared(agentId: string): void;
}

interface AttentionTarget {
  workspaceId: string;
  agentId: string;
  observed: ReadonlyMap<string, string> | null;
}

/** Apply agent attention policy within the authoritative owning workspace. */
export class WorkspaceAttention {
  constructor(private readonly deps: WorkspaceAttentionDependencies) {}

  /** Report each successful mutation immediately, preserving partial results if a later write fails. */
  async clear(input: WorkspaceAttentionClearInput): Promise<void> {
    const observed = this.observedAttention(input.workspace, input.notification);
    // Sibling workspaces can share a directory; only workspaceId establishes ownership.
    const clearableAgentIds = input.agents
      .filter((agent) => !agent.archivedAt)
      .filter((agent) => agent.workspaceId === input.workspace.workspaceId)
      .filter((agent) => agent.requiresAttention === true)
      .filter((agent) => (agent.pendingPermissions?.length ?? 0) === 0)
      .filter((agent) => agent.attentionReason !== "permission")
      .filter((agent) => !observed || observed.get(agent.id) === agent.attentionTimestamp)
      .map((agent) => agent.id);

    for (const agentId of clearableAgentIds) {
      if (await this.clearAgent({ workspaceId: input.workspace.workspaceId, agentId, observed })) {
        input.onCleared(agentId);
      }
    }
  }

  /** Validate the fixed delivery boundary before mutation and exclude newer attention sources. */
  private observedAttention(
    workspace: PersistedWorkspaceRecord,
    notification: NotificationAcknowledgement | undefined,
  ): Map<string, string> | null {
    if (!notification) return null;
    new NotificationReceipts(workspace.notificationReceipts).acknowledge(notification);
    const observed = new Map(notification.attention.map((item) => [item.agentId, item.timestamp]));
    const events = workspace.notificationReceipts?.attentionEvents ?? {};
    if (notification.kind === "workspace") {
      for (const [agentId, event] of Object.entries(events)) {
        if (event.sequence > notification.throughSequence) {
          observed.delete(agentId);
        } else if (!observed.has(agentId)) {
          observed.set(agentId, event.timestamp);
        }
      }
    } else {
      for (const agentId of observed.keys()) {
        const latest = events[agentId];
        if (latest && latest.sequence !== notification.sequence) observed.delete(agentId);
      }
    }
    return observed;
  }

  /** Live state is rechecked at dispatch; durable state uses the storage queue's timestamp comparison. */
  private async clearAgent(input: AttentionTarget): Promise<boolean> {
    const liveAgent = this.deps.manager.getAgent(input.agentId);
    if (!liveAgent) return this.clearStoredAgent(input);
    if (
      input.observed &&
      (!liveAgent.attention.requiresAttention ||
        liveAgent.attention.attentionTimestamp.toISOString() !== input.observed.get(input.agentId))
    ) {
      return false;
    }
    await this.deps.manager.clearAgentAttention(input.agentId);
    return true;
  }

  /** Publish only committed stored mutations, preserving existing shared-workspace visibility rules. */
  private async clearStoredAgent(input: AttentionTarget): Promise<boolean> {
    const record = await this.deps.storage.get(input.agentId);
    if (!record || record.internal || record.archivedAt || record.requiresAttention !== true) {
      return false;
    }
    if (input.observed && input.observed.get(input.agentId) !== record.attentionTimestamp) {
      return false;
    }
    // Legacy reads also mutate the latest queued record rather than upserting
    // a captured snapshot over unrelated writes that completed while we waited.
    const timestamp = input.observed
      ? input.observed.get(input.agentId)
      : record.attentionTimestamp;
    if (input.observed && !timestamp) return false;
    const nextRecord = await this.deps.storage.clearAttentionIfUnchanged(input.agentId, timestamp);
    if (!nextRecord) return false;
    await this.deps.publishStored(nextRecord, input.workspaceId);
    return true;
  }
}
