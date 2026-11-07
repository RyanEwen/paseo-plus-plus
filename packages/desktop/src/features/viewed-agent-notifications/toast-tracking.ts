import type { AgentDeepLinkTarget } from "@getpaseo/protocol/agent-deep-link";
import type { DeliveredAgentToast, KnownAgentNotification } from "./controller.js";

/** The part of an Electron Notification that viewed-chat tracking listens to. */
export interface ShowableNotification {
  on(event: "show", listener: () => void): unknown;
}

/** Windows Notification Center history operations used for viewed chats. */
export interface ViewedToastHistory {
  list(): Promise<DeliveredAgentToast[]>;
  remove(toasts: DeliveredAgentToast[]): Promise<void>;
  removeCurrentLive(tag: string): Promise<void>;
}

/** How a viewed-chat dismissal reaches the toast history on this build. */
export interface ViewedToastHistoryActions {
  list(): Promise<DeliveredAgentToast[]>;
  remove(toasts: DeliveredAgentToast[]): Promise<void>;
  /** Removes a just-shown toast from history, or null when this build has no history to clean. */
  removeViewedLive: ((notificationId: string) => Promise<void>) | null;
}

interface ViewedToastHistoryInput {
  /** True only on a packaged Windows build whose toast identity is verified. */
  canReadHistory: boolean;
  history: ViewedToastHistory;
}

/** Decide once which toast-history operations a viewed chat may run on this build. */
export function viewedToastHistoryActions(
  input: ViewedToastHistoryInput,
): ViewedToastHistoryActions {
  return {
    list: () => (input.canReadHistory ? input.history.list() : Promise.resolve([])),
    remove: (toasts) => input.history.remove(toasts),
    // Removal needs the same verified packaged identity as reading.
    removeViewedLive: input.canReadHistory ? (id) => input.history.removeCurrentLive(id) : null,
  };
}

interface TrackViewedToastInput<N> {
  notification: N;
  target: AgentDeepLinkTarget;
  notificationId: string;
  isViewed(target: AgentDeepLinkTarget): boolean;
  /** Closes and releases the notification; called at most once, after it has shown. */
  dismiss(notification: N): void;
  removeViewedLive: ViewedToastHistoryActions["removeViewedLive"];
}

/**
 * Keep the chat notifications that may still need closing once their chat is viewed.
 *
 * A pending native Show cannot be canceled by closing the JS wrapper, so a close requested
 * before "show" waits for the show callback, which then removes that exact toast.
 */
export function createViewedToastRegistry<N extends ShowableNotification>() {
  const known = new Map<N, KnownAgentNotification>();

  function track(input: TrackViewedToastInput<N>): void {
    const { notification, target } = input;
    let shown = false;
    let dismissWhenShown = false;

    const dismissKnown = () => {
      if (!shown) {
        dismissWhenShown = true;
        return;
      }
      input.dismiss(notification);
    };

    known.set(notification, { target, close: dismissKnown });
    notification.on("show", () => {
      shown = true;
      if (!dismissWhenShown && !input.isViewed(target)) return;
      dismissKnown();
      if (input.removeViewedLive) {
        void input
          .removeViewedLive(input.notificationId)
          .catch((error) =>
            console.warn("[notifications] Failed to remove viewed toast from history", error),
          );
      }
    });
  }

  return {
    track,
    /** Stop tracking a released notification. */
    forget: (notification: N) => known.delete(notification),
    values: () => known.values(),
  };
}

export type ViewedToastRegistry<N extends ShowableNotification> = ReturnType<
  typeof createViewedToastRegistry<N>
>;
