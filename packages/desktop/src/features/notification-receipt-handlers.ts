import type { NotificationCloseEventParams } from "electron";
import { z } from "zod";
import {
  DesktopNotificationReceipts,
  notificationHistoryIdentifier,
} from "./notification-receipts.js";
import { classifyWindowsNotificationClose } from "./windows-agent-notification.js";
import type { DeliveredAgentToast, WindowsToastHistory } from "./windows-toast-history.js";

/** The part of an Electron Notification that receipt tracking uses. */
export interface ReceiptNotification {
  close(): void;
  on(event: "show", listener: () => void): unknown;
}

/** Main-process services the receipt handlers need, injected so tests run without Electron. */
export interface NotificationReceiptPorts<N extends ReceiptNotification> {
  /** Registers one renderer IPC handler (`ipcMain.handle`). */
  handle(channel: string, handler: (event: unknown, input: unknown) => unknown): void;
  /** Sends an argument-free event to every renderer window. */
  broadcast(channel: string): void;
  /** Opens the durable receipt store; called lazily, on first use. */
  openReceipts(): DesktopNotificationReceipts;
  /** This build's Notification Center history, or null when it has none to read. */
  history: Pick<WindowsToastHistory, "list" | "remove"> | null;
  /** Releases a live notification the receipt handlers closed. */
  release(notification: N): void;
}

interface DeliveryRecord {
  /** Opaque history identity, or `live:<id>` for a notification with no history entry. */
  identifier: string;
  /** The Electron notification id, which keys the durable routing record. */
  nativeIdentifier: string;
  data: Record<string, unknown> | undefined;
}

interface RetainDeliveryInput {
  notificationId: string;
  data: Record<string, unknown> | undefined;
  /** The Windows toast launch arguments, or null when the notification has no toast XML. */
  launch: string | null;
}

interface ClosedDeliveryInput {
  notificationId: string;
  reason: NotificationCloseEventParams["reason"];
}

const IdentifierListSchema = z.array(z.string().min(1)).max(256);

/** What the send path does with each delivered notification's receipt. */
export interface NotificationDeliveryReceipts<N extends ReceiptNotification> {
  /** Register the renderer receipt IPC; call once, before any delivery. */
  register(ports: NotificationReceiptPorts<N>): void;
  /** Persist delivery identity before showing, and announce the delivery once shown. */
  retain(notification: N, input: RetainDeliveryInput): void;
  /** Mark a close the app requested, so it is never recorded as a user dismissal. */
  markProgrammatic(notification: N): void;
  /** Record an explicit user dismissal and say whether to retain, acknowledge or release. */
  closed(
    notification: N,
    input: ClosedDeliveryInput,
  ): ReturnType<typeof classifyWindowsNotificationClose>;
  /** Forget a released notification. */
  forget(notification: N): void;
}

/**
 * Track each delivered notification's receipt and serve the renderer's delivery-receipt IPC
 * (list, dismiss, pending and acknowledged dismissals).
 *
 * Create it at module scope beside the other live-notification registries; `register` wires
 * the main-process ports. The receipt store is opened at the IPC or callback boundary, so a
 * damaged receipt file cannot abort app startup.
 */
export function createNotificationDeliveryReceipts<
  N extends ReceiptNotification,
>(): NotificationDeliveryReceipts<N> {
  let ports: NotificationReceiptPorts<N> | null = null;
  let store: DesktopNotificationReceipts | null = null;
  const records = new Map<N, DeliveryRecord>();
  const programmaticDismissals = new WeakSet<N>();

  function requirePorts(): NotificationReceiptPorts<N> {
    if (!ports) throw new Error("Notification delivery receipts are not registered");
    return ports;
  }

  function receipts(): DesktopNotificationReceipts {
    store ??= requirePorts().openReceipts();
    return store;
  }

  /** Durable history entries this app can still resolve, or none when history is unreadable. */
  async function readPersistedHistory(): Promise<
    ReturnType<DesktopNotificationReceipts["history"]>
  > {
    const history = requirePorts().history;
    if (!history) return [];
    try {
      return receipts().history(await history.list());
    } catch (error) {
      // Identity verification failures leave history untouched; live own entries still reconcile.
      console.warn("[notifications] Could not inspect owned notification history", error);
      return [];
    }
  }

  /** Remove the selected history entries and return the ones actually removed. */
  async function removeHistory(selected: ReadonlySet<string>): Promise<DeliveredAgentToast[]> {
    const history = requirePorts().history;
    if (!history) return [];
    const delivered = (await history.list()).filter((item) => {
      const identifier = notificationHistoryIdentifier(item);
      return identifier !== null && selected.has(identifier);
    });
    if (delivered.length > 0) await history.remove(delivered);
    return delivered;
  }

  /** Close and release the live notifications whose identifiers were selected. */
  function closeSelected(selected: ReadonlySet<string>): string[] {
    const closed: string[] = [];
    for (const [notification, record] of records) {
      if (!selected.has(record.identifier)) continue;
      programmaticDismissals.add(notification);
      notification.close();
      requirePorts().release(notification);
      closed.push(record.nativeIdentifier);
    }
    return closed;
  }

  function registerIpc(host: NotificationReceiptPorts<N>): void {
    host.handle("paseo:notification:listDelivered", async () => {
      const live = [...records.values()].map(({ identifier, data }) => ({ identifier, data }));
      const persisted = await readPersistedHistory();
      const byId = new Map([...persisted, ...live].map((item) => [item.identifier, item]));
      return [...byId.values()];
    });

    host.handle("paseo:notification:dismissDelivered", async (_event, input) => {
      const selected = new Set(IdentifierListSchema.parse(input));
      const removedHistory = await removeHistory(selected);
      const closed = closeSelected(selected);
      // Release selected live instances even if durable mapping retirement fails.
      // Keep persistence errors visible to the caller; they are not acknowledgements.
      receipts().forgetHistory(removedHistory);
      receipts().forget(closed);
    });

    host.handle("paseo:notification:pendingDismissals", () => receipts().pending());

    host.handle("paseo:notification:acknowledgeDismissals", (_event, input) => {
      receipts().acknowledge(IdentifierListSchema.parse(input));
    });
  }

  return {
    register(host) {
      ports = host;
      registerIpc(host);
    },

    retain(notification, { notificationId, data, launch }) {
      const historyIdentity = launch
        ? notificationHistoryIdentifier({
            namespace: "current",
            group: "Notifications",
            tag: notificationId,
            arguments: launch,
          })
        : null;
      // Persist event identity before showing; a process restart must not lose history ownership.
      try {
        receipts().shown(notificationId, data, historyIdentity ?? undefined);
      } catch (error) {
        console.warn("[notifications] Could not preserve notification routing", error);
      }
      records.set(notification, {
        identifier: historyIdentity ?? `live:${notificationId}`,
        nativeIdentifier: notificationId,
        data,
      });
      notification.on("show", () => requirePorts().broadcast("paseo:event:notification-delivered"));
    },

    markProgrammatic(notification) {
      programmaticDismissals.add(notification);
    },

    closed(notification, { notificationId, reason }) {
      const disposition = classifyWindowsNotificationClose({
        reason,
        programmatic: programmaticDismissals.delete(notification),
      });
      if (disposition !== "acknowledge") return disposition;
      try {
        if (receipts().dismissed(notificationId)) {
          requirePorts().broadcast("paseo:event:notification-dismissals-changed");
        }
      } catch (error) {
        console.warn("[notifications] Could not preserve explicit dismissal", error);
      }
      return disposition;
    },

    forget(notification) {
      records.delete(notification);
    },
  };
}
