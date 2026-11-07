import { useSyncExternalStore } from "react";
import { createStore } from "zustand/vanilla";

/**
 * A source that can temporarily block settings edits, such as a settings host that has not
 * finished loading. The source owns its own state; this module only relays it to editors.
 */
export interface SettingsEditingBlocker {
  /** Return true while edits must wait. */
  isBlocked: () => boolean;
  /** Notify the listener whenever isBlocked may have changed; return an unsubscribe function. */
  subscribe: (listener: () => void) => () => void;
}

/** The registered blocker; the store's own subscription reports registration changes. */
const registration = createStore<{ blocker: SettingsEditingBlocker | null }>(() => ({
  blocker: null,
}));

/**
 * Register the single editing blocker for this build.
 *
 * Returns an unregister function. Throws when another blocker is already registered, so two
 * features cannot silently compete for the same gate.
 */
export function registerSettingsEditingBlocker(next: SettingsEditingBlocker): () => void {
  if (registration.getState().blocker) {
    throw new Error("A settings editing blocker is already registered");
  }
  registration.setState({ blocker: next });
  return () => {
    if (registration.getState().blocker !== next) return;
    registration.setState({ blocker: null });
  };
}

/** Read the current state; false when no blocker is registered. */
export function isSettingsEditingBlocked(): boolean {
  return registration.getState().blocker?.isBlocked() ?? false;
}

/** Subscribe to both registration changes and the registered blocker's own changes. */
function subscribe(listener: () => void): () => void {
  let unsubscribeBlocker = registration.getState().blocker?.subscribe(listener) ?? null;
  const unsubscribeRegistration = registration.subscribe(({ blocker }) => {
    unsubscribeBlocker?.();
    unsubscribeBlocker = blocker?.subscribe(listener) ?? null;
    listener();
  });
  return () => {
    unsubscribeRegistration();
    unsubscribeBlocker?.();
  };
}

/** React view of the registered blocker. */
export function useSettingsEditingBlocked(): boolean {
  return useSyncExternalStore(subscribe, isSettingsEditingBlocked, isSettingsEditingBlocked);
}
