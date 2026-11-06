// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  listSettingsDomainAdapters,
  registerSettingsDomainAdapter,
  subscribeSettingsDomainAdapters,
  useSettingsDomainAdapter,
  type SettingsDomainAdapter,
} from "./domain-adapters";

/** Ids currently registered, in registration order. */
function registeredIds(): string[] {
  return listSettingsDomainAdapters().map((adapter) => adapter.id);
}

describe("settings domain adapter registry", () => {
  it("lists adapters in registration order and notifies on every change", () => {
    let notifications = 0;
    const unsubscribe = subscribeSettingsDomainAdapters(() => {
      notifications += 1;
    });
    const unregisterFirst = registerSettingsDomainAdapter({ id: "test-first" });
    const unregisterSecond = registerSettingsDomainAdapter({ id: "test-second" });
    try {
      const ids = registeredIds();
      expect(ids.indexOf("test-first")).toBeLessThan(ids.indexOf("test-second"));
    } finally {
      unregisterFirst();
      unregisterSecond();
      unsubscribe();
    }
    expect(registeredIds()).not.toContain("test-first");
    expect(notifications).toBe(4);
  });

  it("rejects a duplicate id and the reserved app id", () => {
    const unregister = registerSettingsDomainAdapter({ id: "test-duplicate" });
    try {
      expect(() => registerSettingsDomainAdapter({ id: "test-duplicate" })).toThrow(
        "already registered",
      );
      expect(() => registerSettingsDomainAdapter({ id: "app" })).toThrow("reserved");
    } finally {
      unregister();
    }
  });

  it("ignores a stale unregister after the id is registered again", () => {
    const stale = registerSettingsDomainAdapter({ id: "test-replaced" });
    stale();
    const current = registerSettingsDomainAdapter({ id: "test-replaced" });
    try {
      stale();
      expect(registeredIds()).toContain("test-replaced");
    } finally {
      current();
    }
  });

  it("registers from an effect for the lifetime of the component", () => {
    const adapter: SettingsDomainAdapter = { id: "test-hook" };
    const { rerender, unmount } = renderHook(() => useSettingsDomainAdapter(adapter));
    expect(registeredIds()).toContain("test-hook");

    // Re-rendering with the same adapter keeps one registration instead of throwing.
    rerender();
    expect(registeredIds().filter((id) => id === "test-hook")).toHaveLength(1);

    unmount();
    expect(registeredIds()).not.toContain("test-hook");
  });
});
