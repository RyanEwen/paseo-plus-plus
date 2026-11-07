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
}

const WORKSPACE_STATE_BUCKET_PRIORITY = {
  needs_input: 0,
  failed: 1,
  running: 2,
  attention: 3,
  done: 4,
} as const satisfies Record<WorkspaceStateBucket, number>;

export function deriveAgentStateBucket(input: AgentStateBucketInput): WorkspaceStateBucket {
  if ((input.pendingPermissionCount ?? 0) > 0 || input.attentionReason === "permission") {
    return "needs_input";
  }
  if (input.status === "error" || input.attentionReason === "error") {
    return "failed";
  }
  if (input.requiresAttention && input.attentionMessage) {
    return "attention";
  }
  if (input.status === "running") {
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
  if (input.status === "error" || input.attentionReason === "error") {
    return 1;
  }
  if (input.status === "running") {
    return 2;
  }
  if (input.status === "initializing") {
    return 3;
  }
  return 4;
}
