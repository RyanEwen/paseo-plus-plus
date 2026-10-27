import { z } from "zod";
import type { MutableDaemonConfig } from "./messages.js";

/** Optional host-owned preferences. Future notification leaves remain intact when this one changes. */
export const DaemonNotificationPreferencesSchema = z
  .object({ agentAwareAttention: z.boolean().optional() })
  .passthrough();

export const AgentAttentionPeerSchema = z.object({
  agentId: z.string().min(1),
  serverId: z.string().min(1).optional(),
});
export type AgentAttentionPeer = z.infer<typeof AgentAttentionPeerSchema>;

/** A daemon-issued capability linking a reply to one delegated objective. Never render its token. */
export const AgentAttentionLinkSchema = z.object({
  objectiveId: z.string().min(1),
  token: z.string().min(1),
  requestId: z.string().min(1),
});
export type AgentAttentionLink = z.infer<typeof AgentAttentionLinkSchema>;

export const AgentMessageAttentionSchema = z.object({
  requesterObjective: AgentAttentionLinkSchema.optional(),
  continuation: AgentAttentionLinkSchema.optional(),
  delivery: z.object({ outcomeId: z.string(), deliveryId: z.string() }).optional(),
});
export type AgentMessageAttention = z.infer<typeof AgentMessageAttentionSchema>;

export const AgentAttentionRequestQuerySchema = z.object({
  link: AgentAttentionLinkSchema,
  requester: AgentAttentionPeerSchema,
  acknowledgeOutcomeId: z.string().optional(),
});
export type AgentAttentionRequestQuery = z.infer<typeof AgentAttentionRequestQuerySchema>;

export const AgentObjectiveAudienceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("human") }),
  z.object({ kind: z.literal("agent"), requester: AgentAttentionPeerSchema }),
]);

export const AgentAttentionObjectivesSchema = z.object({
  activeObjectiveIds: z.array(z.string()),
  objectives: z.array(
    z.object({
      id: z.string(),
      audience: AgentObjectiveAudienceSchema,
      disposition: z.enum(["normal", "waiting", "final"]),
    }),
  ),
});
export type AgentAttentionObjectives = z.infer<typeof AgentAttentionObjectivesSchema>;

export interface HumanAttentionInput {
  humanAttentionRequired?: boolean;
  requiresAttention?: boolean;
  pendingPermissionCount?: number;
  status?: string;
}

/** Read the daemon's audience decision; absent metadata retains the older host's behavior. */
export function hasHumanAgentAttention(input: HumanAttentionInput): boolean {
  if (input.humanAttentionRequired !== undefined) {
    return input.humanAttentionRequired;
  }
  // COMPAT(agentAudienceAttention): added in v0.12.0, remove after 2027-04-22 once host floor includes audience metadata.
  return (
    input.requiresAttention === true ||
    (input.pendingPermissionCount ?? 0) > 0 ||
    input.status === "error"
  );
}

/** One host-owned optional preference, default enabled without writing a device mirror. */
export function isAgentAwareAttentionEnabled(
  config: Pick<MutableDaemonConfig, "notifications">,
): boolean {
  return config.notifications?.agentAwareAttention !== false;
}
