import * as Notifications from "expo-notifications";
import type { NotificationDismissal } from "@getpaseo/protocol/notification-receipts";

export interface DeliveredWorkspaceNotification {
  identifier: string;
  data: Record<string, unknown> | undefined;
}
export interface NotificationReceiptDevice {
  list(): Promise<DeliveredWorkspaceNotification[]>;
  dismiss(identifier: string): Promise<void>;
  pending(): Promise<NotificationDismissal[]>;
  acknowledge(ids: string[]): Promise<void>;
  subscribe(listener: (notification?: DeliveredWorkspaceNotification) => void): Promise<() => void>;
}

/** iOS can apply synchronized receipts on resume; explicit tray swipes have no JS callback. */
export class ExpoNotificationReceiptDevice implements NotificationReceiptDevice {
  async list(): Promise<DeliveredWorkspaceNotification[]> {
    return (await Notifications.getPresentedNotificationsAsync()).map((notification) => ({
      identifier: notification.request.identifier,
      data: notification.request.content.data,
    }));
  }
  dismiss(identifier: string): Promise<void> {
    return Notifications.dismissNotificationAsync(identifier);
  }
  async pending(): Promise<NotificationDismissal[]> {
    return [];
  }
  async acknowledge(_ids: string[]): Promise<void> {}
  async subscribe(
    listener: (notification?: DeliveredWorkspaceNotification) => void,
  ): Promise<() => void> {
    const received = Notifications.addNotificationReceivedListener((notification) =>
      listener({
        identifier: notification.request.identifier,
        data: notification.request.content.data,
      }),
    );
    return () => received.remove();
  }
}
