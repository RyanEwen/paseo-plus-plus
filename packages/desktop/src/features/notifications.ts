import {
  DesktopNotificationReceipts,
  notificationHistoryIdentifier,
} from "./notification-receipts.js";
import { z } from "zod";
import { desktopDistribution } from "../distribution.js";
import {
  createViewedAgentNotifications,
  type KnownAgentNotification,
  type DeliveredAgentToast,
} from "./viewed-agent-notifications.js";
import { createWindowsToastHistory } from "./windows-toast-history.js";
import path from "node:path";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { cacheNotificationIcon, readNotificationIconBytes } from "./notification-icon.js";
import { app, BrowserWindow, Notification, ipcMain, nativeImage } from "electron";
import { getDesktopSettingsStore } from "../settings/desktop-settings-electron.js";
import {
  buildWindowsAgentToast,
  buildWindowsAgentNotificationArguments,
  createWindowsAgentNotificationOpener,
  classifyWindowsNotificationClose,
} from "./windows-agent-notification.js";

interface NotificationInput {
  title?: unknown;
  body?: unknown;
  data?: unknown;
  icon?: unknown;
}

interface NotificationClickPayload {
  data?: Record<string, unknown>;
}

const activeNotifications = new Set<Notification>();
const notificationRecords = new Map<
  Notification,
  { identifier: string; nativeIdentifier: string; data: Record<string, unknown> | undefined }
>();
const programmaticDismissals = new WeakSet<Notification>();
const agentNotifications = new Map<Notification, KnownAgentNotification>();

function releaseNotification(notification: Notification): void {
  activeNotifications.delete(notification);
  notificationRecords.delete(notification);
  agentNotifications.delete(notification);
}

function toTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function getNotificationIcon(): { image: Electron.NativeImage; path: string } | null {
  const candidates = [
    path.resolve(__dirname, "../assets/icon.png"),
    path.resolve(__dirname, "../assets/64x64.png"),
    path.resolve(__dirname, "../assets/128x128.png"),
  ];

  for (const iconPath of candidates) {
    if (!existsSync(iconPath)) {
      continue;
    }
    const icon = nativeImage.createFromPath(iconPath);
    if (!icon.isEmpty()) {
      return { image: icon, path: iconPath };
    }
  }

  return null;
}

/** Accept only small renderer-rasterized PNG bytes, never paths or remote URLs.
 * Windows ToastGeneric requires a file URI; retain content-addressed files in the
 * app-owned cache so Notification Center can render them after app restart.
 */
async function getProjectNotificationIcon(value: unknown) {
  const inputBytes = readNotificationIconBytes(value);
  if (!inputBytes) return null;
  const image = nativeImage.createFromBuffer(inputBytes);
  if (image.isEmpty()) return null;
  const size = image.getSize();
  if (size.width === 0 || size.width > 128 || size.width !== size.height) return null;
  const bytes = image.toPNG();
  const directory = path.join(app.getPath("userData"), "notification-icons");
  let iconPath = "";
  if (process.platform === "win32") {
    try {
      iconPath = await cacheNotificationIcon({ directory, bytes });
    } catch (error) {
      console.warn("[notifications] Could not prepare project icon", error);
      return null;
    }
  }
  return { image, path: iconPath };
}

function focusSenderWindow(sender: Electron.WebContents): BrowserWindow | null {
  const win = BrowserWindow.fromWebContents(sender) ?? BrowserWindow.getAllWindows()[0] ?? null;
  if (!win || win.isDestroyed()) {
    return null;
  }
  win.show();
  if (win.isMinimized()) {
    win.restore();
  }
  win.focus();
  return win;
}

/**
 * macOS requires a notification to have been shown at least once before
 * the app appears in System Preferences > Notifications. We fire a
 * silent no-op notification during startup to ensure registration.
 */
export function ensureNotificationCenterRegistration(): void {
  if (process.platform !== "darwin" || !Notification.isSupported()) {
    return;
  }

  const probe = new Notification({ title: app.name, silent: true });
  probe.on("show", () => probe.close());
  setTimeout(() => probe.close(), 2_000);
  probe.show();
}

export function registerNotificationHandlers(openAgentLink: (url: string) => void): void {
  let receiptStore: DesktopNotificationReceipts | null = null;
  // Load at the IPC/callback boundary, so a damaged receipt file cannot abort app startup.
  function receipts(): DesktopNotificationReceipts {
    receiptStore ??= new DesktopNotificationReceipts(app.getPath("userData"));
    return receiptStore;
  }
  const canReadHistory =
    process.platform === "win32" &&
    app.isPackaged &&
    desktopDistribution.windowsAppUserModelId !== null;
  const history = createWindowsToastHistory({
    executable: process.execPath,
    isPackagedFork: app.isPackaged && desktopDistribution.windowsAppUserModelId !== null,
  });
  ipcMain.handle("paseo:notification:listDelivered", async () => {
    const known = [...notificationRecords.values()].map(({ identifier, data }) => ({
      identifier,
      data,
    }));
    let persisted: ReturnType<DesktopNotificationReceipts["history"]> = [];
    if (canReadHistory) {
      try {
        persisted = receipts().history(await history.list());
      } catch (error) {
        // Identity verification failures leave history untouched; live own entries still reconcile.
        console.warn("[notifications] Could not inspect owned notification history", error);
      }
    }
    const byId = new Map([...persisted, ...known].map((item) => [item.identifier, item]));
    return [...byId.values()];
  });
  ipcMain.handle("paseo:notification:dismissDelivered", async (_event, input: unknown) => {
    const identifiers = z.array(z.string().min(1)).max(256).parse(input);
    const selected = new Set(identifiers);
    const forgotten = new Set<string>();
    let removedHistory: DeliveredAgentToast[] = [];
    if (canReadHistory) {
      const delivered = (await history.list()).filter((item) => {
        const identifier = notificationHistoryIdentifier(item);
        return identifier !== null && selected.has(identifier);
      });
      if (delivered.length) await history.remove(delivered);
      removedHistory = delivered;
    }
    for (const [notification, record] of notificationRecords) {
      if (!selected.has(record.identifier)) continue;
      programmaticDismissals.add(notification);
      notification.close();
      releaseNotification(notification);
      forgotten.add(record.nativeIdentifier);
    }
    // Release selected live instances even if durable mapping retirement fails.
    // Keep persistence errors visible to the caller; they are not acknowledgements.
    receipts().forgetHistory(removedHistory);
    receipts().forget([...forgotten]);
  });
  ipcMain.handle("paseo:notification:pendingDismissals", () => receipts().pending());
  ipcMain.handle("paseo:notification:acknowledgeDismissals", (_event, input: unknown) => {
    receipts().acknowledge(z.array(z.string().min(1)).max(256).parse(input));
  });
  const viewed = createViewedAgentNotifications({
    canView(windowId) {
      const win = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.webContents.id === windowId,
      );
      return Boolean(
        win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && win.isFocused(),
      );
    },
    known: () => agentNotifications.values(),
    list: () => (canReadHistory ? history.list() : Promise.resolve([])),
    remove: (toasts) => history.remove(toasts),
  });
  const targetSchema = z.object({
    serverId: z.string().trim().min(1),
    agentId: z.string().trim().min(1),
  });
  const viewSchema = z.object({
    revision: z.number().int().nonnegative(),
    target: targetSchema.nullable(),
  });
  ipcMain.handle("paseo:notification:setViewedAgent", async (event, raw: unknown) => {
    const view = viewSchema.parse(raw);
    await viewed.setView(event.sender.id, view);
  });
  app.on("web-contents-created", (_event, contents) => {
    const id = contents.id;
    contents.on("did-start-navigation", (_navigationEvent, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) viewed.removeWindow(id);
    });
    contents.once("destroyed", () => viewed.removeWindow(id));
  });
  const openWindowsNotification = createWindowsAgentNotificationOpener(openAgentLink);
  if (process.platform === "win32") {
    // This also receives clicks after the original Notification was collected
    // or the app restarted. The existing agent-link owner queues cold-start hops.
    Notification.handleActivation((details) => {
      openWindowsNotification(details);
    });
    // Electron 44.5.1 registers the Windows COM activator when its presenter is
    // initialized, not when handleActivation installs the callback.
    Notification.isSupported();
  }

  ipcMain.handle("paseo:notification:isSupported", () => {
    return Notification.isSupported();
  });

  /** Preserve delivery identity and register the delivery event before showing.
   * Persistence failure keeps the existing live notification behavior. */
  function retainNotificationDelivery(
    notification: Notification,
    notificationId: string,
    data: Record<string, unknown> | undefined,
    toastXml: string | null,
  ): void {
    const historyIdentity = toastXml
      ? notificationHistoryIdentifier({
          namespace: "current",
          group: "Notifications",
          tag: notificationId,
          arguments: buildWindowsAgentNotificationArguments({ notificationId, data }) ?? "",
        })
      : null;
    // Persist event identity before showing; a process restart must not lose history ownership.
    try {
      receipts().shown(notificationId, data, historyIdentity ?? undefined);
    } catch (error) {
      console.warn("[notifications] Could not preserve notification routing", error);
    }
    notificationRecords.set(notification, {
      identifier: historyIdentity ?? `live:${notificationId}`,
      nativeIdentifier: notificationId,
      data,
    });
    notification.on("show", () => {
      for (const window of BrowserWindow.getAllWindows())
        window.webContents.send("paseo:event:notification-delivered", {});
    });
    activeNotifications.add(notification);
  }

  ipcMain.handle("paseo:notification:send", async (event, rawInput?: NotificationInput) => {
    if (!Notification.isSupported()) {
      return false;
    }

    const title = toTrimmedString(rawInput?.title);
    if (!title) {
      return false;
    }

    const body = toTrimmedString(rawInput?.body) ?? undefined;
    const data = toRecord(rawInput?.data);
    const parsedTarget = targetSchema.safeParse(data);
    const target = parsedTarget.success ? parsedTarget.data : null;
    const notificationId = randomUUID();
    const icon = (await getProjectNotificationIcon(rawInput?.icon)) ?? getNotificationIcon();
    const settings = await getDesktopSettingsStore().get();
    if (target && viewed.isViewed(target)) return true;
    const silent = !settings.notifications.playSound;
    const toastXml =
      process.platform === "win32"
        ? buildWindowsAgentToast({
            notificationId,
            title,
            body,
            data,
            iconPath: icon?.path ?? null,
            silent,
          })
        : null;
    const notification = new Notification({
      id: notificationId,
      title,
      ...(body ? { body } : {}),
      ...(icon ? { icon: icon.image } : {}),
      ...(toastXml ? { toastXml } : {}),
      silent,
    });

    retainNotificationDelivery(notification, notificationId, data, toastXml);
    if (target) {
      let shown = false;
      let dismissWhenShown = false;
      const dismissKnown = () => {
        // A pending native Show cannot be canceled by closing the JS wrapper.
        // Preserve it until its show callback can remove this exact toast.
        if (!shown) {
          dismissWhenShown = true;
          return;
        }
        programmaticDismissals.add(notification);
        notification.close();
        releaseNotification(notification);
      };
      agentNotifications.set(notification, { target, close: dismissKnown });
      notification.on("show", () => {
        shown = true;
        if (dismissWhenShown || viewed.isViewed(target)) {
          dismissKnown();
          if (process.platform === "win32") {
            void history
              .removeCurrentLive(notificationId)
              .catch((error) =>
                console.warn("[notifications] Failed to remove viewed toast from history", error),
              );
          }
        }
      });
    }

    notification.on("click", () => {
      // Electron 44 can report a foreground body tap only on the instance.
      // Route it through the same opener used by durable COM activations.
      if (toastXml) {
        const launch = buildWindowsAgentNotificationArguments({ notificationId, data });
        if (launch) {
          openWindowsNotification({ type: "click", arguments: launch });
        }
        releaseNotification(notification);
        return;
      }
      const win = focusSenderWindow(event.sender);
      if (win && data && Object.keys(data).length > 0) {
        const payload: NotificationClickPayload = { data };
        win.webContents.send("paseo:event:notification-click", payload);
      }
      releaseNotification(notification);
    });

    notification.on("close", (closeEvent) => {
      const disposition = classifyWindowsNotificationClose({
        reason: closeEvent.reason,
        programmatic: programmaticDismissals.delete(notification),
      });
      if (disposition === "acknowledge") {
        try {
          if (receipts().dismissed(notificationId)) {
            for (const window of BrowserWindow.getAllWindows())
              window.webContents.send("paseo:event:notification-dismissals-changed", {});
          }
        } catch (error) {
          console.warn("[notifications] Could not preserve explicit dismissal", error);
        }
      }

      if (process.platform === "win32" && disposition === "retain") {
        // getHistory() is macOS-only and returns an empty list on Windows.
        // Keep this reference so foreground Center taps retain their listener.
        return;
      }
      releaseNotification(notification);
    });

    notification.on("failed", () => {
      releaseNotification(notification);
    });

    notification.show();
    return true;
  });
}
