import { describe, expect, it } from "vitest";
import { isSettingsEditingBlocked, registerSettingsEditingBlocker } from "./editing-blocker";

/** Build a blocker whose state the test controls. */
function controlledBlocker(initial: boolean) {
  let blocked = initial;
  const listeners = new Set<() => void>();
  return {
    blocker: {
      isBlocked: () => blocked,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    set(value: boolean) {
      blocked = value;
      for (const listener of listeners) listener();
    },
  };
}

describe("settings editing blocker", () => {
  it("allows edits when no blocker is registered", () => {
    expect(isSettingsEditingBlocked()).toBe(false);
  });

  it("relays the registered blocker and stops after unregistering", () => {
    const control = controlledBlocker(true);
    const unregister = registerSettingsEditingBlocker(control.blocker);
    try {
      expect(isSettingsEditingBlocked()).toBe(true);
      control.set(false);
      expect(isSettingsEditingBlocked()).toBe(false);
    } finally {
      unregister();
    }
    control.set(true);
    expect(isSettingsEditingBlocked()).toBe(false);
  });

  it("rejects a second blocker", () => {
    const unregister = registerSettingsEditingBlocker(controlledBlocker(false).blocker);
    try {
      expect(() => registerSettingsEditingBlocker(controlledBlocker(true).blocker)).toThrow(
        "already registered",
      );
    } finally {
      unregister();
    }
  });
});
