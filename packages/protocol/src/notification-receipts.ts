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

/**
 * Why a host permanently refused a notification acknowledgement. Retrying cannot succeed:
 * the workspace is archived or gone, or the receipt names a sequence the host never issued.
 */
export const NotificationRejectionSchema = z.enum(["workspace_unavailable", "unknown_sequence"]);
export type NotificationRejection = z.infer<typeof NotificationRejectionSchema>;

/** A permanent refusal, as distinct from a transport failure the sender should retry. */
export class NotificationRejectedError extends Error {
  constructor(
    readonly rejection: NotificationRejection,
    message: string,
  ) {
    super(message);
    this.name = "NotificationRejectedError";
  }
}

/**
 * Whether an error is a permanent acknowledgement refusal. Matches by name and reason rather than
 * `instanceof`, so the check holds when the protocol package is loaded more than once.
 */
export function isNotificationRejection(error: unknown): error is NotificationRejectedError {
  return (
    error instanceof Error &&
    error.name === "NotificationRejectedError" &&
    NotificationRejectionSchema.safeParse((error as { rejection?: unknown }).rejection).success
  );
}

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

  /**
   * Apply an acknowledgement: a workspace read settles everything through its boundary, an event
   * dismissal settles one sequence, and contiguous dismissals then fold into the boundary.
   *
   * @throws NotificationRejectedError when the receipt names a sequence never issued.
   */
  acknowledge(acknowledgement: NotificationAcknowledgement): void {
    this.assertAcknowledgeable(acknowledgement);
    if (acknowledgement.kind === "workspace") {
      this.acknowledgeWorkspace(acknowledgement);
    } else {
      this.dismissEvent(acknowledgement.sequence);
    }
    this.compactDismissals();
  }

  /**
   * Check, without changing anything, that a receipt names only already-issued events, never a
   * reconnect-time future.
   *
   * @throws NotificationRejectedError for an unknown sequence.
   */
  assertAcknowledgeable(acknowledgement: NotificationAcknowledgement): void {
    const sequence =
      acknowledgement.kind === "workspace"
        ? acknowledgement.throughSequence
        : acknowledgement.sequence;
    // A workspace read may settle nothing (boundary 0); an event names a delivered sequence.
    const minimum = acknowledgement.kind === "event" ? 1 : 0;
    const issued =
      Number.isSafeInteger(sequence) &&
      sequence >= minimum &&
      sequence <= this.value.latestSequence;
    if (!issued) {
      throw new NotificationRejectedError("unknown_sequence", "Unknown notification sequence");
    }
  }

  private acknowledgeWorkspace(
    acknowledgement: Extract<NotificationAcknowledgement, { kind: "workspace" }>,
  ): void {
    this.value.acknowledgedThrough = Math.max(
      this.value.acknowledgedThrough,
      acknowledgement.throughSequence,
    );
    // A delayed retry must not become a new workspace opening for a legacy startup backlog.
    const observedCurrentRead =
      acknowledgement.observedReadId === undefined ||
      acknowledgement.observedReadId === (this.value.lastWorkspaceReadId ?? null);
    if (observedCurrentRead) {
      this.value.lastWorkspaceReadId = acknowledgement.acknowledgementId;
    }
  }

  private dismissEvent(sequence: number): void {
    if (sequence > this.value.acknowledgedThrough) {
      this.value.dismissedSequences.push(sequence);
    }
  }

  /** Fold dismissals that continue the acknowledged boundary into it and drop settled ones. */
  private compactDismissals(): void {
    const dismissed = [...new Set(this.value.dismissedSequences)]
      .filter((item) => item > this.value.acknowledgedThrough)
      .sort((a, b) => a - b);
    let folded = 0;
    while (folded < dismissed.length && dismissed[folded] === this.value.acknowledgedThrough + 1) {
      this.value.acknowledgedThrough = dismissed[folded];
      folded++;
    }
    this.value.dismissedSequences = dismissed.slice(folded);
  }

  /**
   * Forget the attention events of agents that no longer exist once those events are settled.
   *
   * An event stays while it is unacknowledged (a receipt may still name it) or while its agent
   * exists (a later receipt may still clear that agent). Archived and deleted agents can never be
   * cleared, so their settled events would otherwise accumulate for the workspace's lifetime.
   *
   * @param liveAgentIds agents that still exist and are not archived.
   */
  pruneAttention(liveAgentIds: ReadonlySet<string>): void {
    const events = this.value.attentionEvents;
    if (!events) return;
    this.value.attentionEvents = Object.fromEntries(
      Object.entries(events).filter(
        ([agentId, event]) => liveAgentIds.has(agentId) || !this.includes(event.sequence),
      ),
    );
  }

  /** Match a delivered event exactly; untagged legacy notifications are never inferred read. */
  includes(sequence: number): boolean {
    return (
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
