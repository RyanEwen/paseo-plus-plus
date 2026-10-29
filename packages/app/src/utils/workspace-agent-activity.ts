import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import { isWorkspaceRootAgent } from "@/subagents/policies";
import { deriveSidebarStateBucket } from "./sidebar-agent-state";
import { getWorkspaceStateBucketPriority } from "@getpaseo/protocol/agent-state-bucket";

export interface WorkspaceAgentActivity {
  agentId: string;
  status: WorkspaceDescriptor["status"];
  enteredAt: Date | null;
}

function workspaceAgentStatus(agent: Agent): Agent["status"] {
  if (agent.turn.phase === "open") return "running";
  return agent.status === "running" ? "idle" : agent.status;
}

/** Preserve legacy recency selection while known audiences use blocker and explicit-review priority. */
function shouldReplaceWorkspaceActivity(
  agent: Agent,
  status: WorkspaceDescriptor["status"],
  enteredAt: Date,
  current: WorkspaceAgentActivity,
  agents: ReadonlyMap<string, Agent>,
): boolean {
  const currentAgent = agents.get(current.agentId);
  const usePriority =
    agent.humanAttentionRequired !== undefined ||
    currentAgent?.humanAttentionRequired !== undefined;
  let priorityDifference =
    getWorkspaceStateBucketPriority(status) - getWorkspaceStateBucketPriority(current.status);
  const explicitReview = agent.requiresAttention && agent.attentionMessage;
  const currentReview = currentAgent?.requiresAttention && currentAgent.attentionMessage;
  if (explicitReview && (current.status === "running" || current.status === "done"))
    priorityDifference = -1;
  if (currentReview && (status === "running" || status === "done")) priorityDifference = 1;
  if (usePriority && priorityDifference > 0) return false;
  if (
    (!usePriority || priorityDifference === 0) &&
    current.enteredAt &&
    enteredAt <= current.enteredAt
  )
    return false;
  return true;
}

export function buildWorkspaceAgentActivityIndex(
  agents: ReadonlyMap<string, Agent>,
  previous?: ReadonlyMap<string, WorkspaceAgentActivity>,
): Map<string, WorkspaceAgentActivity> {
  const activityByWorkspaceId = new Map<string, WorkspaceAgentActivity>();

  for (const agent of agents.values()) {
    const parentAgent = agent.parentAgentId ? agents.get(agent.parentAgentId) : undefined;
    // COMPAT(agentAudienceAttention): added in v0.12.0, remove after 2027-04-22 once host floor includes audience metadata.
    const contributes =
      agent.humanAttentionRequired !== undefined || isWorkspaceRootAgent(agent, parentAgent);
    if (agent.archivedAt || !agent.workspaceId || !contributes) {
      continue;
    }

    const enteredAt = agent.attentionTimestamp ?? agent.updatedAt;
    const status = deriveSidebarStateBucket({
      status: workspaceAgentStatus(agent),
      pendingPermissionCount: agent.pendingPermissions.length,
      requiresAttention: agent.requiresAttention,
      attentionReason: agent.attentionReason,
      attentionMessage: agent.attentionMessage,
    });
    const current = activityByWorkspaceId.get(agent.workspaceId);
    if (current && !shouldReplaceWorkspaceActivity(agent, status, enteredAt, current, agents))
      continue;
    activityByWorkspaceId.set(agent.workspaceId, {
      agentId: agent.id,
      status,
      enteredAt,
    });
  }

  for (const [workspaceId, activity] of activityByWorkspaceId) {
    const previousActivity = previous?.get(workspaceId);
    if (
      previousActivity?.agentId === activity.agentId &&
      previousActivity.status === activity.status
    ) {
      activityByWorkspaceId.set(workspaceId, previousActivity);
    }
  }

  if (previous && areWorkspaceAgentActivityIndexesIdentical(previous, activityByWorkspaceId)) {
    return previous instanceof Map ? previous : new Map(previous);
  }
  return activityByWorkspaceId;
}

function areWorkspaceAgentActivityIndexesIdentical(
  previous: ReadonlyMap<string, WorkspaceAgentActivity>,
  next: ReadonlyMap<string, WorkspaceAgentActivity>,
): boolean {
  if (previous.size !== next.size) {
    return false;
  }
  for (const [workspaceId, activity] of next) {
    if (previous.get(workspaceId) !== activity) {
      return false;
    }
  }
  return true;
}
