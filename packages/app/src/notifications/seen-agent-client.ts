import * as Notifications from "expo-notifications";
import { createSeenAgentNotifications } from "./seen-agent";

export const seenAgentNotifications = createSeenAgentNotifications({
  async list() {
    const notifications = await Notifications.getPresentedNotificationsAsync();
    return notifications.map((notification) => ({
      identifier: notification.request.identifier,
      data: notification.request.content.data,
    }));
  },
  dismiss: Notifications.dismissNotificationAsync,
  async setViewedTarget() {},
  onError: (error) =>
    console.warn("[notifications] Failed to dismiss viewed chat notification", error),
});

let listeners = 0;
let subscription: { remove(): void } | null = null;

/**
 * Dismiss notifications that arrive for the viewed chat while a view is active.
 *
 * Each caller holds the native received-listener until it calls the returned stop function;
 * the listener is registered while at least one caller holds it.
 */
export function startSeenAgentNotifications(): () => void {
  listeners += 1;
  subscription ??= Notifications.addNotificationReceivedListener((notification) => {
    void seenAgentNotifications.dismissReceived({
      identifier: notification.request.identifier,
      data: notification.request.content.data,
    });
  });
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    listeners -= 1;
    if (listeners === 0) {
      subscription?.remove();
      subscription = null;
    }
  };
}
