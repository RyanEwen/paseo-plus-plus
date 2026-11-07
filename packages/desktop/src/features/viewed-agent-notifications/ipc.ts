import type { AgentDeepLinkTarget } from "@getpaseo/protocol/agent-deep-link";
import { app, BrowserWindow, ipcMain, type Notification } from "electron";
import {
  agentNotificationTargetSchema,
  createViewedAgentNotifications,
  viewedAgentNotificationInputSchema,
} from "./controller.js";
import {
  viewedToastHistoryActions,
  type ViewedToastHistory,
  type ViewedToastRegistry,
} from "./toast-tracking.js";

interface RegisterViewedAgentNotificationsInput {
  toasts: ViewedToastRegistry<Notification>;
  /** This build's Notification Center history, or null when it has none. */
  history: ViewedToastHistory | null;
  /** Closes and releases a notification whose chat became visible. */
  dismiss(notification: Notification): void;
}

/** The send path's view of viewed-chat suppression. */
export interface ViewedAgentNotifications {
  /** The chat a notification payload targets, or null for other notifications. */
  targetOf(data: Record<string, unknown> | undefined): AgentDeepLinkTarget | null;
  isViewed(target: AgentDeepLinkTarget): boolean;
  /** Close this notification later if its chat becomes, or already is, visible when it shows. */
  track(
    notification: Notification,
    input: { target: AgentDeepLinkTarget; notificationId: string },
  ): void;
}

/**
 * Register the renderer's viewed-chat reports and window lifetime tracking.
 *
 * A chat counts as viewed only in a visible, focused window whose latest report names it.
 */
export function registerViewedAgentNotifications(
  input: RegisterViewedAgentNotificationsInput,
): ViewedAgentNotifications {
  const historyActions = viewedToastHistoryActions(input.history);
  const controller = createViewedAgentNotifications({
    canView(windowId) {
      const win = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.webContents.id === windowId,
      );
      return Boolean(
        win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && win.isFocused(),
      );
    },
    known: () => input.toasts.values(),
    list: historyActions.list,
    remove: historyActions.remove,
  });

  ipcMain.handle("paseo:notification:setViewedAgent", async (event, raw: unknown) => {
    const view = viewedAgentNotificationInputSchema.parse(raw);
    await controller.setView(event.sender.id, view);
  });

  // A navigation or destroyed renderer no longer shows the chat it last reported.
  app.on("web-contents-created", (_event, contents) => {
    const id = contents.id;
    contents.on("did-start-navigation", (_navigationEvent, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) controller.removeWindow(id);
    });
    contents.once("destroyed", () => controller.removeWindow(id));
  });

  return {
    targetOf(data) {
      const parsed = agentNotificationTargetSchema.safeParse(data);
      return parsed.success ? parsed.data : null;
    },
    isViewed: controller.isViewed,
    track(notification, { target, notificationId }) {
      input.toasts.track({
        notification,
        target,
        notificationId,
        isViewed: controller.isViewed,
        dismiss: input.dismiss,
        removeViewedLive: historyActions.removeViewedLive,
      });
    },
  };
}
