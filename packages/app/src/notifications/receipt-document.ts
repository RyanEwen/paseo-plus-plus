import { z } from "zod";
import {
  NotificationAcknowledgementSchema,
  WORKSPACE_NOTIFICATION_ATTENTION_LIMIT,
  type NotificationAcknowledgement,
} from "@getpaseo/protocol/notification-receipts";

/** One acknowledgement waiting for its host, in send order. */
export interface QueuedAcknowledgement {
  workspaceId: string;
  notification: NotificationAcknowledgement;
}

/** An own notification shown before receipts existed, captured once at startup. */
export interface LegacyNotification {
  identifier: string;
  data?: Record<string, unknown>;
  workspaceId: string | null;
  /** The workspace read identity when captured; undefined until the workspace's receipts arrive. */
  capturedReadId?: string | null;
}

/** Device-local key-value storage for the receipt document. */
export interface ReceiptStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

const OutboxSchema = z.array(
  z.object({ workspaceId: z.string(), notification: NotificationAcknowledgementSchema }),
);

const WorkspaceAcknowledgementSchema = NotificationAcknowledgementSchema.options[0];
const CapturedWorkspaceAcknowledgementSchema = WorkspaceAcknowledgementSchema.extend({
  attention: z.array(WorkspaceAcknowledgementSchema.shape.attention.element),
});
const OversizedStoredWorkspaceAcknowledgementSchema = CapturedWorkspaceAcknowledgementSchema.extend(
  {
    attention: CapturedWorkspaceAcknowledgementSchema.shape.attention.min(
      WORKSPACE_NOTIFICATION_ATTENTION_LIMIT + 1,
    ),
    // Every entry written by the oversized-capture bug stored this CAS boundary.
    // Do not invent one for an unrecognized legacy document.
    observedReadId: z.string().nullable(),
  },
).strict();
const LegacyNotificationsSchema = z.array(
  z.object({
    identifier: z.string(),
    data: z.record(z.string(), z.unknown()).optional(),
    workspaceId: z.string().nullable(),
    capturedReadId: z.string().nullable().optional(),
  }),
);
const ReceiptDocumentSchema = z.object({ outbox: OutboxSchema, legacy: LegacyNotificationsSchema });
const RecoverableReceiptDocumentSchema = ReceiptDocumentSchema.extend({
  outbox: z.array(
    z
      .object({
        workspaceId: z.string(),
        notification: z.union([
          NotificationAcknowledgementSchema,
          OversizedStoredWorkspaceAcknowledgementSchema,
        ]),
      })
      .strict(),
  ),
}).strict();

/** Keep every captured observation under one fixed workspace read identity. */
export function boundedAcknowledgements(
  notification: NotificationAcknowledgement,
): NotificationAcknowledgement[] {
  if (notification.kind !== "workspace")
    return [NotificationAcknowledgementSchema.parse(notification)];
  const captured = CapturedWorkspaceAcknowledgementSchema.parse(notification);
  const chunks: NotificationAcknowledgement[] = [];
  for (
    let offset = 0;
    offset < Math.max(captured.attention.length, 1);
    offset += WORKSPACE_NOTIFICATION_ATTENTION_LIMIT
  ) {
    chunks.push(
      NotificationAcknowledgementSchema.parse({
        ...captured,
        attention: captured.attention.slice(
          offset,
          offset + WORKSPACE_NOTIFICATION_ATTENTION_LIMIT,
        ),
      }),
    );
  }
  return chunks;
}

/** Repair only otherwise-valid workspace entries from the known oversized writer.
 * Validate the entire result before changing memory or durable storage. */
function restoreReceiptDocument(value: unknown): z.infer<typeof ReceiptDocumentSchema> {
  const ordinary = ReceiptDocumentSchema.safeParse(value);
  if (ordinary.success) return ordinary.data;
  const recoverable = RecoverableReceiptDocumentSchema.parse(value);
  const outbox = recoverable.outbox.flatMap((entry) =>
    boundedAcknowledgements(entry.notification).map((notification) => ({
      workspaceId: entry.workspaceId,
      notification,
    })),
  );
  return ReceiptDocumentSchema.parse({ outbox, legacy: recoverable.legacy });
}

/**
 * One host's durable acknowledgement outbox and legacy capture.
 *
 * Writes are chained in order. Each queued entry is visible to the sender only behind a write
 * that contains that exact entry, so a restart can never resend an entry it never stored, nor
 * lose one it already sent.
 */
export class ReceiptDocument {
  outbox: QueuedAcknowledgement[] = [];
  legacy: LegacyNotification[] = [];
  private writes: Promise<void> = Promise.resolve();
  private durable: Promise<void> = Promise.resolve();
  private readonly persistedEntries = new WeakMap<QueuedAcknowledgement, Promise<void>>();

  constructor(
    private readonly storage: ReceiptStorage,
    private readonly key: string,
  ) {}

  /** Restore the stored document, repairing entries from the known oversized writer. */
  async load(): Promise<void> {
    const stored = await this.storage.getItem(this.key);
    if (!stored) return;
    const parsed: unknown = JSON.parse(stored);
    const document = restoreReceiptDocument(parsed);
    this.outbox = document.outbox;
    this.legacy = document.legacy;
  }

  /** Queue an acknowledgement, split into bounded entries under one read identity. */
  enqueue(workspaceId: string, notification: NotificationAcknowledgement): void {
    const entries = OutboxSchema.parse(
      boundedAcknowledgements(notification).map((part) => ({ workspaceId, notification: part })),
    );
    this.outbox.push(...entries);
  }

  /** Write the current document after every earlier write. */
  persist(): Promise<void> {
    const document = ReceiptDocumentSchema.parse({ outbox: this.outbox, legacy: this.legacy });
    const serialized = JSON.stringify(document);
    const write = this.writes.then(() => this.storage.setItem(this.key, serialized));
    for (const acknowledgement of this.outbox) this.persistedEntries.set(acknowledgement, write);
    this.durable = write;
    this.writes = write.catch(() => {});
    return write;
  }

  /** Settles with the latest write; rejects when it failed. */
  whenDurable(): Promise<void> {
    return this.durable;
  }

  /** The write that first contained this entry, or undefined when it was never written. */
  persistedWrite(acknowledgement: QueuedAcknowledgement): Promise<void> | undefined {
    return this.persistedEntries.get(acknowledgement);
  }
}
