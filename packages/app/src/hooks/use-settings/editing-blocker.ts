import { useSyncExternalStore } from "react";

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

let blocker: SettingsEditingBlocker | null = null;
const registrationListeners = new Set<() => void>();

/**
 * Register the single editing blocker for this build.
 *
 * Returns an unregister function. Throws when another blocker is already registered, so two
 * features cannot silently compete for the same gate.
 */
export function registerSettingsEditingBlocker(next: SettingsEditingBlocker): () => void {
  if (blocker) throw new Error("A settings editing blocker is already registered");
  blocker = next;
  notifyRegistration();
  return () => {
    if (blocker !== next) return;
    blocker = null;
    notifyRegistration();
  };
}

/** Read the current state; false when no blocker is registered. */
export function isSettingsEditingBlocked(): boolean {
  return blocker?.isBlocked() ?? false;
}

/** Subscribe to both registration changes and the registered blocker's own changes. */
function subscribe(listener: () => void): () => void {
  let unsubscribeBlocker = blocker?.subscribe(listener) ?? null;
  const onRegistration = () => {
    unsubscribeBlocker?.();
    unsubscribeBlocker = blocker?.subscribe(listener) ?? null;
    listener();
  };
  registrationListeners.add(onRegistration);
  return () => {
    registrationListeners.delete(onRegistration);
    unsubscribeBlocker?.();
  };
}

function notifyRegistration(): void {
  for (const listener of registrationListeners) listener();
}

/** React view of the registered blocker. */
export function useSettingsEditingBlocked(): boolean {
  return useSyncExternalStore(subscribe, isSettingsEditingBlocked, isSettingsEditingBlocked);
}
