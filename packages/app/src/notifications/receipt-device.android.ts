import { requireNativeModule, type EventSubscription } from "expo-modules-core";
import {
  NotificationDismissalSchema,
  type NotificationDismissal,
} from "@getpaseo/protocol/notification-receipts";
import {
  ExpoNotificationReceiptDevice,
  type DeliveredWorkspaceNotification,
} from "./receipt-device-expo";

interface NativeNotificationReceipts {
  pending(): Promise<string[]>;
  acknowledge(ids: string[]): Promise<void>;
  addListener(event: "dismissalsChanged", listener: () => void): EventSubscription;
}
const native = requireNativeModule<NativeNotificationReceipts>("PaseoNotificationReceipts");

/** The native receiver preserves exact swipes while JS is stopped; remove them only after server success. */
class AndroidNotificationReceiptDevice extends ExpoNotificationReceiptDevice {
  override async pending(): Promise<NotificationDismissal[]> {
    return (await native.pending()).map((item) =>
      NotificationDismissalSchema.parse(JSON.parse(item)),
    );
  }
  override acknowledge(ids: string[]): Promise<void> {
    return native.acknowledge(ids);
  }
  override async subscribe(
    listener: (notification?: DeliveredWorkspaceNotification) => void,
  ): Promise<() => void> {
    const stopReceived = await super.subscribe(listener);
    const subscription = native.addListener("dismissalsChanged", () => listener());
    return () => {
      stopReceived();
      subscription.remove();
    };
  }
}
export const notificationReceiptDevice = new AndroidNotificationReceiptDevice();
