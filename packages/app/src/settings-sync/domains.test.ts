import { describe, expect, it } from "vitest";
import {
  registerSettingsDomainAdapter,
  type SettingsDomainAdapter,
  type SettingsDomainContext,
} from "@/hooks/use-settings/domain-adapters";
import { DEFAULT_CLIENT_SETTINGS } from "@/hooks/use-settings/storage";
import {
  applyDomainValues,
  collectDomainDeviceValues,
  filterDomainAppExport,
  initializeDomains,
  ownedDomainAppKeys,
  trackDomainEdits,
} from "./domains";

const publish: SettingsDomainContext = { purpose: "publish", selectedHost: "host-a" };

describe("settings sync domain composition", () => {
  it("collects device values under each adapter id and excludes owned app keys", async () => {
    const list: SettingsDomainAdapter[] = [
      { id: "sidebar", ownedAppKeys: ["sidebarRowItems"], readDeviceValues: () => ({ a: 1 }) },
      { id: "accent", ownedAppKeys: ["accentColor"] },
    ];
    expect(await collectDomainDeviceValues(list, publish)).toEqual({ sidebar: { a: 1 } });
    expect([...ownedDomainAppKeys(list)].sort()).toEqual(["accentColor", "sidebarRowItems"]);
  });

  it("applies publication filters in registration order", () => {
    const appending = (id: string, mark: string): SettingsDomainAdapter => ({
      id,
      filterAppExport: (app) => ({ ...app, order: [...(app.order as string[]), mark] }),
    });
    const list = [appending("first", "a"), appending("second", "b")];
    expect(filterDomainAppExport(list, { order: [] }, publish)).toEqual({ order: ["a", "b"] });
  });

  it("applies adopted values in order and stops at the first initialization failure", async () => {
    const calls: string[] = [];
    const list: SettingsDomainAdapter[] = [
      {
        id: "first",
        initialize: async () => {
          calls.push("init first");
        },
        applyValues: (values) => {
          calls.push(`apply first ${JSON.stringify(values.first)}`);
        },
      },
      {
        id: "second",
        initialize: async () => {
          throw new Error("local store unavailable");
        },
      },
      {
        id: "third",
        initialize: async () => {
          calls.push("init third");
        },
      },
    ];

    await applyDomainValues(list, { first: 1 }, DEFAULT_CLIENT_SETTINGS);
    await expect(initializeDomains(list)).rejects.toThrow("local store unavailable");
    expect(calls).toEqual(["apply first 1", "init first"]);
  });
});

describe("settings sync domain edit tracking", () => {
  /** An adapter whose edit observer records its start and stop in calls. */
  function recordingObserver(id: string, calls: string[]): SettingsDomainAdapter {
    return {
      id,
      observeEdits: () => {
        calls.push(`start ${id}`);
        return () => calls.push(`stop ${id}`);
      },
    };
  }

  it("follows later registrations and removals, and stops the rest newest first", () => {
    const calls: string[] = [];
    const unregisterA = registerSettingsDomainAdapter(recordingObserver("test-track-a", calls));
    const stop = trackDomainEdits();
    const unregisterB = registerSettingsDomainAdapter(recordingObserver("test-track-b", calls));
    const unregisterC = registerSettingsDomainAdapter(recordingObserver("test-track-c", calls));
    try {
      unregisterB();
      stop();
      stop();
      // Removal after stop no longer reaches an observer.
      unregisterC();
    } finally {
      unregisterA();
      unregisterB();
      unregisterC();
    }
    expect(calls).toEqual([
      "start test-track-a",
      "start test-track-b",
      "start test-track-c",
      "stop test-track-b",
      "stop test-track-c",
      "stop test-track-a",
    ]);
  });

  it("stops installed observers when an initial install fails", () => {
    const calls: string[] = [];
    const unregisterA = registerSettingsDomainAdapter(recordingObserver("test-fail-a", calls));
    const unregisterBroken = registerSettingsDomainAdapter({
      id: "test-fail-broken",
      observeEdits: () => {
        throw new Error("committer unavailable");
      },
    });
    try {
      expect(() => trackDomainEdits()).toThrow("committer unavailable");
    } finally {
      unregisterA();
      unregisterBroken();
    }
    expect(calls).toEqual(["start test-fail-a", "stop test-fail-a"]);
  });
});
