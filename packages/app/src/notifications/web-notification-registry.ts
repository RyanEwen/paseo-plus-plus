import type { PresentedAgentNotification } from "./seen-agent";

const notifications = new Map<
  string,
  { notification: PresentedAgentNotification; close(): void }
>();
let nextIdentifier = 0;

/** The browser Notification surface the app uses for its own web notifications. */
export interface WebNotificationInstance {
  close(): void;
  addEventListener: (type: "click" | "close", listener: (event: Event) => void) => void;
}

/** Retain only this browser session's own notifications; browsers do not expose durable OS history. */
export function retainWebNotification(
  data: Record<string, unknown> | undefined,
  notification: WebNotificationInstance,
): void {
  const identifier = `web-${++nextIdentifier}`;
  notifications.set(identifier, {
    notification: { identifier, data },
    close: () => notification.close(),
  });
  notification.addEventListener("close", () => notifications.delete(identifier));
}

export async function listWebNotifications(): Promise<PresentedAgentNotification[]> {
  return [...notifications.values()].map((entry) => entry.notification);
}

export async function dismissWebNotification(identifier: string): Promise<void> {
  const entry = notifications.get(identifier);
  if (!entry) return;
  entry.close();
  notifications.delete(identifier);
}
