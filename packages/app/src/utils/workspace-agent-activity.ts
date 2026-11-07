import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import { isWorkspaceRootAgent } from "@/subagents/policies";
import { deriveSidebarStateBucket } from "./sidebar-agent-state";
import {
  getWorkspaceStateBucketPriority,
  isOutrankedByExplicitReview,
} from "@getpaseo/protocol/agent-state-bucket";

export interface WorkspaceAgentActivity {
  agentId: string;
  status: WorkspaceDescriptor["status"];
  enteredAt: Date | null;
}

function workspaceAgentStatus(agent: Agent): Agent["status"] {
  if (agent.turn.phase === "open") return "running";
  return agent.status === "running" ? "idle" : agent.status;
}

interface WorkspaceActivityCandidate {
  agent: Agent;
  activity: WorkspaceAgentActivity & { enteredAt: Date };
}

/**
 * Decide whether `candidate` replaces the workspace's current activity.
 *
 * `usePriority` is chosen once per workspace, so the reduction is a single comparator and the
 * result does not depend on agent order. Known audiences use blocker and explicit-review
 * priority, then recency; legacy agents keep recency selection.
 */
function shouldReplaceWorkspaceActivity(input: {
  candidate: WorkspaceActivityCandidate;
  current: WorkspaceActivityCandidate;
  usePriority: boolean;
}): boolean {
  const { candidate, current, usePriority } = input;
  const status = candidate.activity.status;
  const currentStatus = current.activity.status;
  let priorityDifference =
    getWorkspaceStateBucketPriority(status) - getWorkspaceStateBucketPriority(currentStatus);
  const explicitReview = candidate.agent.requiresAttention && candidate.agent.attentionMessage;
  const currentReview = current.agent.requiresAttention && current.agent.attentionMessage;
  if (explicitReview && isOutrankedByExplicitReview(currentStatus)) {
    priorityDifference = -1;
  }
  if (currentReview && isOutrankedByExplicitReview(status)) {
    priorityDifference = 1;
  }
  if (usePriority && priorityDifference > 0) {
    return false;
  }
  const comparesRecency = !usePriority || priorityDifference === 0;
  if (comparesRecency && candidate.activity.enteredAt <= current.activity.enteredAt) {
    return false;
  }
  return true;
}

/** The contributing agents' activity, grouped by workspace in agent order. */
function collectWorkspaceCandidates(
  agents: ReadonlyMap<string, Agent>,
): Map<string, WorkspaceActivityCandidate[]> {
  const candidatesByWorkspaceId = new Map<string, WorkspaceActivityCandidate[]>();
  for (const agent of agents.values()) {
    const parentAgent = agent.parentAgentId ? agents.get(agent.parentAgentId) : undefined;
    // COMPAT(agentAudienceAttention): added in v0.15.3, remove after 2027-04-22 once host floor includes audience metadata.
    const contributes =
      agent.humanAttentionRequired !== undefined || isWorkspaceRootAgent(agent, parentAgent);
    if (agent.archivedAt || !agent.workspaceId || !contributes) {
      continue;
    }
    const status = deriveSidebarStateBucket({
      status: workspaceAgentStatus(agent),
      pendingPermissionCount: agent.pendingPermissions.length,
      requiresAttention: agent.requiresAttention,
      attentionReason: agent.attentionReason,
      attentionMessage: agent.attentionMessage,
    });
    const activity = {
      agentId: agent.id,
      status,
      enteredAt: agent.attentionTimestamp ?? agent.updatedAt,
    };
    const candidates = candidatesByWorkspaceId.get(agent.workspaceId) ?? [];
    candidates.push({ agent, activity });
    candidatesByWorkspaceId.set(agent.workspaceId, candidates);
  }
  return candidatesByWorkspaceId;
}

export function buildWorkspaceAgentActivityIndex(
  agents: ReadonlyMap<string, Agent>,
  previous?: ReadonlyMap<string, WorkspaceAgentActivity>,
): Map<string, WorkspaceAgentActivity> {
  const activityByWorkspaceId = new Map<string, WorkspaceAgentActivity>();

  for (const [workspaceId, candidates] of collectWorkspaceCandidates(agents)) {
    const usePriority = candidates.some(
      (candidate) => candidate.agent.humanAttentionRequired !== undefined,
    );
    let selected = candidates[0]!;
    for (const candidate of candidates.slice(1)) {
      if (shouldReplaceWorkspaceActivity({ candidate, current: selected, usePriority })) {
        selected = candidate;
      }
    }
    activityByWorkspaceId.set(workspaceId, selected.activity);
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
