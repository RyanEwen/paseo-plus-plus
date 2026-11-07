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

/** Names the exact outcome a callback message delivers to its requester. */
export const AgentAttentionDeliveryRefSchema = z.object({
  outcomeId: z.string(),
  deliveryId: z.string(),
});
export type AgentAttentionDeliveryRef = z.infer<typeof AgentAttentionDeliveryRefSchema>;

export const AgentMessageAttentionSchema = z.object({
  requesterObjective: AgentAttentionLinkSchema.optional(),
  continuation: AgentAttentionLinkSchema.optional(),
  delivery: AgentAttentionDeliveryRefSchema.optional(),
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

/** One objective an agent is working toward, and who receives its result. */
export const AgentAttentionObjectiveSchema = z.object({
  id: z.string(),
  audience: AgentObjectiveAudienceSchema,
  disposition: z.enum(["normal", "waiting", "final"]),
});
export type AgentAttentionObjective = z.infer<typeof AgentAttentionObjectiveSchema>;

/** The objective context an agent reads through get_attention_context. */
export const AgentAttentionContextSchema = z.object({
  activeObjectiveIds: z.array(z.string()),
  objectives: z.array(AgentAttentionObjectiveSchema),
});
export type AgentAttentionContext = z.infer<typeof AgentAttentionContextSchema>;

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
  // COMPAT(agentAudienceAttention): added in v0.15.3, remove after 2027-04-22 once host floor includes audience metadata.
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
