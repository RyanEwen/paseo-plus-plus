import {
  NotificationReceiptDataSchema,
  NotificationReceipts,
  isNotificationRejection,
  type NotificationAcknowledgement,
  type WorkspaceNotificationReceipts,
} from "@getpaseo/protocol/notification-receipts";
import {
  bindLegacyReadIds,
  captureStartupLegacy,
  reconcileLegacyNotifications,
} from "./legacy-notifications";
import { ReceiptDocument, type ReceiptStorage } from "./receipt-document";
import type { NotificationReceiptDevice } from "./receipt-device-expo";

interface ObservedAttention {
  agentId: string;
  timestamp: string;
}
interface WorkspaceReceiptSnapshot {
  id: string;
  notificationReceipts?: WorkspaceNotificationReceipts;
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

/** The foreground workspace's activation; it captures one read boundary, once. */
interface ActiveAcknowledgementLease {
  workspaceId: string;
  lease: symbol;
  captured: boolean;
  /** The read boundary to acknowledge, or null when the workspace had no receipts yet. */
  boundary: NotificationAcknowledgement | null;
}

/** One host's durable delivery acknowledgements. Attention itself stays daemon-owned. */
export class WorkspaceNotificationSynchronizer {
  private readonly snapshots = new Map<string, WorkspaceNotificationReceipts>();
  private readonly initialWorkspaceReadIds = new Map<string, string | null>();
  private readonly document: ReceiptDocument;
  private initialized = false;
  private connected = false;
  private disposed = false;
  private active: ActiveAcknowledgementLease | null = null;
  private pump: Promise<void> | null = null;
  private flushRequested = false;
  private reconcileTail: Promise<void> = Promise.resolve();
  private stopDevice: (() => void) | null = null;

  constructor(private readonly ports: WorkspaceReceiptPorts) {
    this.document = new ReceiptDocument(
      ports.storage,
      `@paseo:notification-receipts:${ports.serverId}`,
    );
  }

  /** Restore fixed acknowledgement boundaries before applying server catch-up or device callbacks. */
  async start(): Promise<void> {
    await this.document.load();
    if (this.disposed) return;
    const presented = await this.ports.device.list();
    if (this.disposed) return;
    const captured = captureStartupLegacy({
      presented,
      serverId: this.ports.serverId,
      known: this.document.legacy,
      readIdFor: (workspaceId) => this.currentReadId(workspaceId),
    });
    this.document.legacy.push(...captured);
    await this.document.persist();
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
        bindLegacyReadIds(
          this.document.legacy,
          workspace.id,
          workspace.notificationReceipts.lastWorkspaceReadId ?? null,
        );
      }
    }
    this.captureActive();
    if (this.initialized) void this.flush().catch(this.ports.report);
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
    if (connected && this.initialized) void this.flush().catch(this.ports.report);
  }

  /**
   * An activation captures once. New notifications on an already-open workspace remain unread.
   *
   * @param snapshot the receipts shown when the workspace opened; defaults to the latest known.
   * @param attention the attention observed when it opened; defaults to the current attention.
   */
  open(
    workspaceId: string,
    snapshot?: WorkspaceNotificationReceipts,
    attention?: ObservedAttention[],
  ): () => void {
    const receipts = snapshot ?? this.snapshots.get(workspaceId);
    const observed = attention ?? this.ports.attention(workspaceId);
    const lease = Symbol("foreground-workspace-notification-acknowledgement");
    this.active = {
      workspaceId,
      lease,
      captured: false,
      boundary: receipts
        ? {
            kind: "workspace",
            acknowledgementId: this.ports.newId(),
            throughSequence: receipts.latestSequence,
            observedReadId: receipts.lastWorkspaceReadId ?? null,
            attention: observed.map((item) => ({ ...item })),
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
    this.document.enqueue(workspaceId, notification);
    await this.document.persist();
    await this.flush();
  }

  /** Prevent an event acknowledged before its delayed delivery from resurfacing locally. */
  isAcknowledged(data: Record<string, unknown> | undefined): boolean {
    // Untagged legacy notifications are never inferred read.
    const receipt = NotificationReceiptDataSchema.safeParse(data);
    if (!receipt.success || receipt.data.serverId !== this.ports.serverId) return false;
    const snapshot = this.snapshots.get(receipt.data.workspaceId);
    if (!snapshot) return false;
    return new NotificationReceipts(snapshot).includes(receipt.data.notificationSequence);
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
      await this.document.whenDurable();
      if (this.connected) {
        for (const dismissal of await this.ports.device.pending()) {
          if (dismissal.data.serverId !== this.ports.serverId) continue;
          const data = dismissal.data;
          const attention =
            data.agentId && data.attentionTimestamp
              ? [{ agentId: data.agentId, timestamp: data.attentionTimestamp }]
              : [];
          await this.deliver(data.workspaceId, {
            kind: "event",
            acknowledgementId: dismissal.id,
            sequence: data.notificationSequence,
            attention,
          });
          await this.ports.device.acknowledge([dismissal.id]);
        }
        while (this.document.outbox.length && !this.disposed) {
          const acknowledgement = this.document.outbox[0];
          // A head appended while pending() awaited may have a newer write than this pass's entry fence.
          const persisted = this.document.persistedWrite(acknowledgement);
          if (!persisted) throw new Error("Notification acknowledgement has not been persisted");
          await persisted;
          if (this.disposed) return;
          await this.deliver(acknowledgement.workspaceId, acknowledgement.notification);
          this.document.outbox.shift();
          await this.document.persist();
        }
      }
    } finally {
      const reconcile = this.reconcileTail.then(() => this.reconcilePresented());
      this.reconcileTail = reconcile.catch(this.ports.report);
      await reconcile;
    }
  }

  /**
   * Send one acknowledgement. A permanent host refusal is reported and treated as settled, so the
   * caller drops the entry instead of retrying it ahead of every later receipt for this host.
   *
   * @throws Transport and other transient failures, which keep the entry queued for a retry.
   */
  private async deliver(
    workspaceId: string,
    acknowledgement: NotificationAcknowledgement,
  ): Promise<void> {
    try {
      await this.ports.acknowledge(workspaceId, acknowledgement);
    } catch (error) {
      if (!isNotificationRejection(error)) throw error;
      this.ports.report(error);
    }
  }

  private async reconcilePresented(): Promise<void> {
    const presented = await this.ports.device.list();
    for (const notification of presented) {
      if (this.disposed) return;
      if (this.isAcknowledged(notification.data)) {
        await this.ports.device.dismiss(notification.identifier);
      }
    }
    await reconcileLegacyNotifications({
      legacy: this.document.legacy,
      connected: this.connected,
      snapshots: this.snapshots,
      initialReadIds: this.initialWorkspaceReadIds,
      resolveAgentWorkspace: (agentId) => this.ports.resolveAgentWorkspace(agentId),
      dismiss: (identifier) => this.ports.device.dismiss(identifier),
      remove: (identifier) => {
        this.document.legacy = this.document.legacy.filter(
          (item) => item.identifier !== identifier,
        );
      },
      persist: () => this.document.persist(),
    });
  }

  /** The workspace's current read identity, or undefined until its receipts arrive. */
  private currentReadId(workspaceId: string): string | null | undefined {
    if (!this.snapshots.has(workspaceId)) return undefined;
    return this.snapshots.get(workspaceId)?.lastWorkspaceReadId ?? null;
  }

  dispose(): void {
    this.disposed = true;
    this.stopDevice?.();
  }
}
