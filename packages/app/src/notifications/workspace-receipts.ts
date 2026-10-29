import { z } from "zod";
import {
  NotificationAcknowledgementSchema,
  WORKSPACE_NOTIFICATION_ATTENTION_LIMIT,
  NotificationReceipts,
  type NotificationAcknowledgement,
  type WorkspaceNotificationReceipts,
} from "@getpaseo/protocol/notification-receipts";
import type { NotificationReceiptDevice } from "./receipt-device-expo";

interface ObservedAttention {
  agentId: string;
  timestamp: string;
}
interface WorkspaceReceiptSnapshot {
  id: string;
  notificationReceipts?: WorkspaceNotificationReceipts;
}
interface QueuedAcknowledgement {
  workspaceId: string;
  notification: NotificationAcknowledgement;
}
interface LegacyNotification {
  identifier: string;
  data?: Record<string, unknown>;
  workspaceId: string | null;
  capturedReadId?: string | null;
}
interface ReceiptStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}
interface WorkspaceReceiptPorts {
  serverId: string;
  device: NotificationReceiptDevice;
  storage: ReceiptStorage;
  acknowledge(workspaceId: string, notification: NotificationAcknowledgement): Promise<void>;
  resolveAgentWorkspace(agentId: string): Promise<string | null>;
  attention(workspaceId: string): ObservedAttention[];
  report(error: unknown): void;
  newId(): string;
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
function boundedAcknowledgements(
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

/** One host's durable delivery acknowledgements. Attention itself stays daemon-owned. */
export class WorkspaceNotificationSynchronizer {
  private readonly snapshots = new Map<string, WorkspaceNotificationReceipts>();
  private readonly initialWorkspaceReadIds = new Map<string, string | null>();
  private outbox: QueuedAcknowledgement[] = [];
  private legacy: LegacyNotification[] = [];
  private initialized = false;
  private connected = false;
  private disposed = false;
  private active: {
    workspaceId: string;
    lease: symbol;
    captured: boolean;
    boundary: NotificationAcknowledgement | null;
  } | null = null;
  private writes: Promise<void> = Promise.resolve();
  private durable: Promise<void> = Promise.resolve();
  private readonly persistedEntries = new WeakMap<QueuedAcknowledgement, Promise<void>>();
  private pump: Promise<void> | null = null;
  private flushRequested = false;
  private reconcileTail: Promise<void> = Promise.resolve();
  private stopDevice: (() => void) | null = null;

  constructor(private readonly ports: WorkspaceReceiptPorts) {}
  private key(): string {
    return `@paseo:notification-receipts:${this.ports.serverId}`;
  }

  /** Restore fixed acknowledgement boundaries before applying server catch-up or device callbacks. */
  async start(): Promise<void> {
    const stored = await this.ports.storage.getItem(this.key());
    if (this.disposed) return;
    if (stored) {
      const parsed: unknown = JSON.parse(stored);
      const document = restoreReceiptDocument(parsed);
      this.outbox = document.outbox;
      this.legacy = document.legacy;
    }
    // Capture only own notifications already present at startup. Future unknown alerts are retained.
    const existing = new Set(this.legacy.map((item) => item.identifier));
    const presented = await this.ports.device.list();
    if (this.disposed) return;
    for (const item of presented) {
      if (
        item.data?.serverId !== this.ports.serverId ||
        typeof item.data.notificationSequence === "number" ||
        existing.has(item.identifier)
      )
        continue;
      const workspaceId = typeof item.data.workspaceId === "string" ? item.data.workspaceId : null;
      this.legacy.push({
        ...item,
        workspaceId,
        capturedReadId:
          workspaceId && this.snapshots.has(workspaceId)
            ? (this.snapshots.get(workspaceId)?.lastWorkspaceReadId ?? null)
            : undefined,
      });
    }
    await this.persist();
    if (this.disposed) return;
    this.initialized = true;
    this.captureActive();
    this.stopDevice = await this.ports.device.subscribe((notification) => {
      if (notification && this.isAcknowledged(notification.data)) {
        void this.ports.device.dismiss(notification.identifier).catch(this.ports.report);
      }
      void this.flush().catch(this.ports.report);
    });
    if (this.disposed) {
      this.stopDevice?.();
      return;
    }
    await this.flush();
  }

  /** Snapshot updates reconcile receipts even when no workspace is open on this device. */
  accept(workspaces: WorkspaceReceiptSnapshot[]): void {
    for (const workspace of workspaces) {
      if (workspace.notificationReceipts) {
        this.snapshots.set(workspace.id, workspace.notificationReceipts);
        if (!this.initialWorkspaceReadIds.has(workspace.id)) {
          this.initialWorkspaceReadIds.set(
            workspace.id,
            workspace.notificationReceipts.lastWorkspaceReadId ?? null,
          );
        }
        for (const legacy of this.legacy) {
          if (legacy.workspaceId === workspace.id && legacy.capturedReadId === undefined) {
            legacy.capturedReadId = workspace.notificationReceipts.lastWorkspaceReadId ?? null;
          }
        }
      }
    }
    this.captureActive();
    if (this.initialized) void this.flush().catch(this.ports.report);
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
    if (connected && this.initialized) void this.flush().catch(this.ports.report);
  }

  /** An activation captures once. New notifications on an already-open workspace remain unread. */
  open(
    workspaceId: string,
    snapshot = this.snapshots.get(workspaceId),
    attention = this.ports.attention(workspaceId),
  ): () => void {
    const lease = Symbol("foreground-workspace-notification-acknowledgement");
    this.active = {
      workspaceId,
      lease,
      captured: false,
      boundary: snapshot
        ? {
            kind: "workspace",
            acknowledgementId: this.ports.newId(),
            throughSequence: snapshot.latestSequence,
            observedReadId: snapshot.lastWorkspaceReadId ?? null,
            attention: attention.map((item) => ({ ...item })),
          }
        : null,
    };
    this.captureActive();
    return () => {
      if (this.active?.lease === lease) this.active = null;
    };
  }

  private captureActive(): void {
    if (
      this.disposed ||
      !this.initialized ||
      !this.active ||
      this.active.captured ||
      !this.active.boundary
    )
      return;
    this.active.captured = true;
    void this.enqueue(this.active.workspaceId, this.active.boundary).catch(this.ports.report);
  }

  /** Called by explicit mark-read UI as well as a foreground workspace activation. */
  async markRead(workspaceId: string): Promise<void> {
    const snapshot = this.snapshots.get(workspaceId);
    if (!this.initialized || this.disposed || !snapshot)
      throw new Error("Waiting for workspace notification state");
    await this.enqueue(workspaceId, {
      kind: "workspace",
      acknowledgementId: this.ports.newId(),
      throughSequence: snapshot.latestSequence,
      observedReadId: snapshot.lastWorkspaceReadId ?? null,
      attention: this.ports.attention(workspaceId),
    });
  }

  private async enqueue(
    workspaceId: string,
    notification: NotificationAcknowledgement,
  ): Promise<void> {
    const entries = OutboxSchema.parse(
      boundedAcknowledgements(notification).map((part) => ({ workspaceId, notification: part })),
    );
    this.outbox.push(...entries);
    await this.persist();
    await this.flush();
  }

  /** Prevent an event acknowledged before its delayed delivery from resurfacing locally. */
  isAcknowledged(data: Record<string, unknown> | undefined): boolean {
    if (data?.serverId !== this.ports.serverId || typeof data.workspaceId !== "string")
      return false;
    const snapshot = this.snapshots.get(data.workspaceId);
    return snapshot
      ? new NotificationReceipts(snapshot).includes(data.notificationSequence)
      : false;
  }

  /** Resolve only after all joined resume/reconnect requests finish their fixed receipt passes. */
  async flush(): Promise<void> {
    if (!this.initialized || this.disposed) return;
    this.flushRequested = true;
    this.pump ??= this.drain();
    return this.pump;
  }

  /** Share follow-up work with every caller; errors reject the drain and retain the durable outbox. */
  private async drain(): Promise<void> {
    try {
      do {
        this.flushRequested = false;
        await this.flushOnce();
      } while (this.flushRequested && !this.disposed);
    } finally {
      this.pump = null;
    }
  }

  private async flushOnce(): Promise<void> {
    try {
      await this.durable;
      if (this.connected) {
        for (const dismissal of await this.ports.device.pending()) {
          if (dismissal.data.serverId !== this.ports.serverId) continue;
          const data = dismissal.data;
          const attention =
            data.agentId && data.attentionTimestamp
              ? [{ agentId: data.agentId, timestamp: data.attentionTimestamp }]
              : [];
          await this.ports.acknowledge(data.workspaceId, {
            kind: "event",
            acknowledgementId: dismissal.id,
            sequence: data.notificationSequence,
            attention,
          });
          await this.ports.device.acknowledge([dismissal.id]);
        }
        while (this.outbox.length && !this.disposed) {
          const acknowledgement = this.outbox[0];
          // A head appended while pending() awaited may have a newer write than this pass's entry fence.
          const persisted = this.persistedEntries.get(acknowledgement);
          if (!persisted) throw new Error("Notification acknowledgement has not been persisted");
          await persisted;
          if (this.disposed) return;
          await this.ports.acknowledge(acknowledgement.workspaceId, acknowledgement.notification);
          this.outbox.shift();
          await this.persist();
        }
      }
    } finally {
      const reconcile = this.reconcileTail.then(() => this.reconcilePresented());
      this.reconcileTail = reconcile.catch(this.ports.report);
      await reconcile;
    }
  }

  private async reconcilePresented(): Promise<void> {
    const presented = await this.ports.device.list();
    for (const notification of presented) {
      if (this.disposed) return;
      if (this.isAcknowledged(notification.data))
        await this.ports.device.dismiss(notification.identifier);
    }
    for (const legacy of this.legacy) {
      if (!legacy.workspaceId && this.connected && typeof legacy.data?.agentId === "string") {
        legacy.workspaceId = await this.ports.resolveAgentWorkspace(legacy.data.agentId);
        // Unresolved ownership stays captured for a later authoritative lookup.
        if (legacy.workspaceId) {
          if (legacy.capturedReadId === undefined && this.snapshots.has(legacy.workspaceId)) {
            legacy.capturedReadId = this.initialWorkspaceReadIds.get(legacy.workspaceId) ?? null;
          }
          await this.persist();
        }
      }
      const snapshot = legacy.workspaceId ? this.snapshots.get(legacy.workspaceId) : null;
      if (
        legacy.capturedReadId !== undefined &&
        snapshot?.lastWorkspaceReadId &&
        snapshot.lastWorkspaceReadId !== legacy.capturedReadId
      ) {
        await this.ports.device.dismiss(legacy.identifier);
        this.legacy = this.legacy.filter((item) => item.identifier !== legacy.identifier);
        await this.persist();
      }
    }
  }

  private persist(): Promise<void> {
    const document = ReceiptDocumentSchema.parse({ outbox: this.outbox, legacy: this.legacy });
    const serialized = JSON.stringify(document);
    const write = this.writes.then(() => this.ports.storage.setItem(this.key(), serialized));
    // Each fixed entry is visible to the sender only behind a write containing that exact entry.
    for (const acknowledgement of this.outbox) this.persistedEntries.set(acknowledgement, write);
    this.durable = write;
    this.writes = write.catch(() => {});
    return write;
  }

  dispose(): void {
    this.disposed = true;
    this.stopDevice?.();
  }
}
