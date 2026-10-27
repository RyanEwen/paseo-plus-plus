import { getDesktopHost } from "@/desktop/host";
import { dismissWebNotification, listWebNotifications } from "./web-notification-registry";
import type { NotificationReceiptDevice } from "./receipt-device-expo";

/** Browser APIs expose no reliable user-dismiss reason; Electron owns its exact close callbacks. */
export const notificationReceiptDevice: NotificationReceiptDevice = {
  async list() {
    const desktop = getDesktopHost()?.notification;
    return desktop?.listDelivered ? desktop.listDelivered() : listWebNotifications();
  },
  async dismiss(identifier) {
    const desktop = getDesktopHost()?.notification;
    if (desktop?.dismissDelivered) await desktop.dismissDelivered([identifier]);
    else await dismissWebNotification(identifier);
  },
  async pending() {
    return (await getDesktopHost()?.notification?.pendingDismissals?.()) ?? [];
  },
  async acknowledge(ids) {
    await getDesktopHost()?.notification?.acknowledgeDismissals?.(ids);
  },
  async subscribe(listener) {
    const events = getDesktopHost()?.events;
    if (!events?.on) return () => {};
    const dismissals = await events.on("notification-dismissals-changed", () => listener());
    const received = await events.on("notification-delivered", () => listener());
    return () => {
      dismissals();
      received();
    };
  },
};
