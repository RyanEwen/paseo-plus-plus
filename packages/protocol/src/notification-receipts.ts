import { z } from "zod";

const SequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Delivery receipts are separate from an agent's unresolved work or permission state. */
export const WorkspaceNotificationReceiptsSchema = z.object({
  latestSequence: SequenceSchema,
  acknowledgedThrough: SequenceSchema,
  dismissedSequences: z.array(SequenceSchema),
  lastWorkspaceReadId: z.string().optional(),
  attentionEvents: z
    .record(z.string(), z.object({ sequence: SequenceSchema, timestamp: z.string() }))
    .optional(),
});
export type WorkspaceNotificationReceipts = z.infer<typeof WorkspaceNotificationReceiptsSchema>;

export const WORKSPACE_NOTIFICATION_ATTENTION_LIMIT = 256;

const ObservedAttentionSchema = z.object({ agentId: z.string().min(1), timestamp: z.string() });
export const NotificationAcknowledgementSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("workspace"),
    acknowledgementId: z.string().min(1),
    throughSequence: SequenceSchema,
    observedReadId: z.string().nullable().optional(),
    attention: z.array(ObservedAttentionSchema).max(WORKSPACE_NOTIFICATION_ATTENTION_LIMIT),
  }),
  z.object({
    kind: z.literal("event"),
    acknowledgementId: z.string().min(1),
    sequence: SequenceSchema,
    attention: z.array(ObservedAttentionSchema).max(1),
  }),
]);
export type NotificationAcknowledgement = z.infer<typeof NotificationAcknowledgementSchema>;

/** Compact durable acknowledgement policy for one workspace's ordered delivery events. */
export class NotificationReceipts {
  private value: WorkspaceNotificationReceipts;

  constructor(value?: WorkspaceNotificationReceipts) {
    this.value = value
      ? NotificationReceipts.copy(value)
      : { latestSequence: 0, acknowledgedThrough: 0, dismissedSequences: [] };
  }

  /** Allocate before delivery; counters survive daemon restarts in the workspace registry. */
  issue(attention?: { agentId: string; timestamp: string }): number {
    if (this.value.latestSequence === Number.MAX_SAFE_INTEGER) {
      throw new Error("Notification sequence exhausted");
    }
    const sequence = ++this.value.latestSequence;
    if (attention) {
      this.value.attentionEvents = {
        ...this.value.attentionEvents,
        [attention.agentId]: { sequence, timestamp: attention.timestamp },
      };
    }
    return sequence;
  }

  /** A receipt can acknowledge only already-issued events, never a reconnect-time future. */
  acknowledge(acknowledgement: NotificationAcknowledgement): void {
    const sequence =
      acknowledgement.kind === "workspace"
        ? acknowledgement.throughSequence
        : acknowledgement.sequence;
    const minimum = acknowledgement.kind === "event" ? 1 : 0;
    if (
      !Number.isSafeInteger(sequence) ||
      sequence < minimum ||
      sequence > this.value.latestSequence
    ) {
      throw new Error("Unknown notification sequence");
    }
    if (acknowledgement.kind === "workspace") {
      this.value.acknowledgedThrough = Math.max(this.value.acknowledgedThrough, sequence);
      // A delayed retry must not become a new workspace opening for a legacy startup backlog.
      if (
        acknowledgement.observedReadId === undefined ||
        acknowledgement.observedReadId === (this.value.lastWorkspaceReadId ?? null)
      ) {
        this.value.lastWorkspaceReadId = acknowledgement.acknowledgementId;
      }
    } else if (sequence > this.value.acknowledgedThrough) {
      this.value.dismissedSequences.push(sequence);
    }
    const dismissed = [...new Set(this.value.dismissedSequences)]
      .filter((item) => item > this.value.acknowledgedThrough)
      .sort((a, b) => a - b);
    while (dismissed[0] === this.value.acknowledgedThrough + 1) {
      this.value.acknowledgedThrough = dismissed.shift()!;
    }
    this.value.dismissedSequences = dismissed;
  }

  /** Match a delivered event exactly; untagged legacy notifications are never inferred read. */
  includes(sequence: unknown): boolean {
    return (
      typeof sequence === "number" &&
      Number.isSafeInteger(sequence) &&
      sequence > 0 &&
      sequence <= this.value.latestSequence &&
      (sequence <= this.value.acknowledgedThrough ||
        this.value.dismissedSequences.includes(sequence))
    );
  }

  private static copy(value: WorkspaceNotificationReceipts): WorkspaceNotificationReceipts {
    const attentionEvents = Object.fromEntries(
      Object.entries(value.attentionEvents ?? {}).map(([id, event]) => [id, { ...event }]),
    );
    return { ...value, dismissedSequences: [...value.dismissedSequences], attentionEvents };
  }

  snapshot(): WorkspaceNotificationReceipts {
    return NotificationReceipts.copy(this.value);
  }
}

export const NotificationReceiptDataSchema = z.object({
  serverId: z.string().min(1),
  workspaceId: z.string().min(1),
  notificationSequence: SequenceSchema.positive(),
  agentId: z.string().optional(),
  attentionTimestamp: z.string().optional(),
});
export const NotificationDismissalSchema = z.object({
  id: z.string().min(1),
  data: NotificationReceiptDataSchema,
});
export type NotificationDismissal = z.infer<typeof NotificationDismissalSchema>;
