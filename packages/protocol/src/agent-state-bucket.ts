import type { AgentLifecycleStatus } from "./agent-lifecycle.js";
import type { WorkspaceStateBucket } from "./messages.js";

export type { WorkspaceStateBucket };
export type AgentAttentionReason = "finished" | "error" | "permission" | null | undefined;

export interface AgentStateBucketInput {
  status: AgentLifecycleStatus;
  pendingPermissionCount?: number;
  requiresAttention?: boolean;
  attentionReason?: AgentAttentionReason;
  attentionMessage?: string | null;
  backgroundWork?: { count: number } | null;
  /** The host's audience decision; false means another agent owns this agent's problems. */
  humanAttentionRequired?: boolean;
}

const WORKSPACE_STATE_BUCKET_PRIORITY = {
  needs_input: 0,
  failed: 1,
  running: 2,
  attention: 3,
  done: 4,
} as const satisfies Record<WorkspaceStateBucket, number>;

// An error is a notification like a finish: once the user has seen it, the agent stops showing as
// failed even though its lifecycle stays "error" until the next turn starts.
function hasUnreadError(input: AgentStateBucketInput): boolean {
  return input.requiresAttention === true && input.attentionReason === "error";
}

/**
 * Failed shows an unread error, and an error whose audience is another agent. That error never
 * raises human attention, so nobody can read it; it stays visible while the agent is in error.
 */
function showsFailure(input: AgentStateBucketInput): boolean {
  if (hasUnreadError(input)) {
    return true;
  }
  return input.status === "error" && input.humanAttentionRequired === false;
}

export function deriveAgentStateBucket(input: AgentStateBucketInput): WorkspaceStateBucket {
  if ((input.pendingPermissionCount ?? 0) > 0 || input.attentionReason === "permission") {
    return "needs_input";
  }
  if (showsFailure(input)) {
    return "failed";
  }
  if (input.requiresAttention && input.attentionMessage) {
    return "attention";
  }
  if (input.status === "running" || (input.backgroundWork?.count ?? 0) > 0) {
    return "running";
  }
  if (input.requiresAttention) {
    return "attention";
  }
  return "done";
}

/**
 * An agent's explicit request for the human outranks only workspace activity that asks nothing
 * of the person (running and done). Blockers and failures still win over it.
 */
export function isOutrankedByExplicitReview(bucket: WorkspaceStateBucket): boolean {
  return bucket === "running" || bucket === "done";
}

export function getWorkspaceStateBucketPriority(bucket: WorkspaceStateBucket): number {
  return WORKSPACE_STATE_BUCKET_PRIORITY[bucket];
}

export function getAgentStatusPriority(input: AgentStateBucketInput): number {
  if ((input.pendingPermissionCount ?? 0) > 0 || input.attentionReason === "permission") {
    return 0;
  }
  if (showsFailure(input)) {
    return 1;
  }
  if (input.status === "running" || (input.backgroundWork?.count ?? 0) > 0) {
    return 2;
  }
  if (input.status === "initializing") {
    return 3;
  }
  return 4;
}
