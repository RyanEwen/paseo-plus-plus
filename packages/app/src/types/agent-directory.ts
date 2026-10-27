import type { Agent } from "@/stores/session-store";

export type AgentDirectoryEntry = Pick<
  Agent,
  | "id"
  | "serverId"
  | "title"
  | "status"
  | "turn"
  | "lastActivityAt"
  | "cwd"
  | "workspaceId"
  | "provider"
  | "requiresAttention"
  | "humanAttentionRequired"
  | "attentionMessage"
  | "attentionReason"
  | "attentionTimestamp"
  | "archivedAt"
  | "createdAt"
  | "labels"
  | "projectPlacement"
> & {
  pendingPermissionCount?: number;
};
