import { describe, expect, it } from "vitest";
import { DEFAULT_CLIENT_SETTINGS } from "@/hooks/use-settings/storage";
import {
  applyDomainValues,
  collectDomainDeviceValues,
  filterDomainAppExport,
  initializeDomains,
  listSettingsSyncDomains,
  ownedDomainAppKeys,
  registerSettingsSyncDomain,
  trackDomainEdits,
  type SettingsSyncContext,
  type SettingsSyncDomain,
} from "./domains";
import type { SettingsSyncModel } from "./model";

const publish: SettingsSyncContext = { purpose: "publish", selectedHost: "host-a" };
// The helpers never call the model; adapters receive it unchanged.
const sync = {} as SettingsSyncModel;

describe("settings sync domain registry", () => {
  it("lists adapters in registration order and unregisters only its own entry", () => {
    const first = registerSettingsSyncDomain({ id: "test-first" });
    const second = registerSettingsSyncDomain({ id: "test-second" });
    try {
      const ids = listSettingsSyncDomains().map((domain) => domain.id);
      expect(ids.indexOf("test-first")).toBeLessThan(ids.indexOf("test-second"));
    } finally {
      first();
      second();
    }
    expect(listSettingsSyncDomains().map((domain) => domain.id)).not.toContain("test-first");
  });

  it("rejects a duplicate id and the reserved app id", () => {
    const unregister = registerSettingsSyncDomain({ id: "test-duplicate" });
    try {
      expect(() => registerSettingsSyncDomain({ id: "test-duplicate" })).toThrow(
        "already registered",
      );
      expect(() => registerSettingsSyncDomain({ id: "app" })).toThrow("reserved");
    } finally {
      unregister();
    }
  });

  it("keeps a re-registered adapter when the replaced adapter's stale unregister runs", () => {
    const stale = registerSettingsSyncDomain({ id: "test-replaced" });
    stale();
    const current = registerSettingsSyncDomain({ id: "test-replaced" });
    try {
      stale();
      expect(listSettingsSyncDomains().map((domain) => domain.id)).toContain("test-replaced");
    } finally {
      current();
    }
  });
});

describe("settings sync domain composition", () => {
  it("collects device values under each adapter id and excludes owned app keys", async () => {
    const list: SettingsSyncDomain[] = [
      { id: "sidebar", ownedAppKeys: ["sidebarRowItems"], readDeviceValues: () => ({ a: 1 }) },
      { id: "accent", ownedAppKeys: ["accentColor"] },
    ];
    expect(await collectDomainDeviceValues(list, publish)).toEqual({ sidebar: { a: 1 } });
    expect([...ownedDomainAppKeys(list)].sort()).toEqual(["accentColor", "sidebarRowItems"]);
  });

  it("applies publication filters in registration order", () => {
    const appending = (id: string, mark: string): SettingsSyncDomain => ({
      id,
      filterAppExport: (app) => ({ ...app, order: [...(app.order as string[]), mark] }),
    });
    const list = [appending("first", "a"), appending("second", "b")];
    expect(filterDomainAppExport(list, { order: [] }, publish)).toEqual({ order: ["a", "b"] });
  });

  it("applies adopted values in order and stops at the first initialization failure", async () => {
    const calls: string[] = [];
    const list: SettingsSyncDomain[] = [
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
  function recordingObserver(id: string, calls: string[]): SettingsSyncDomain {
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
    const unregisterA = registerSettingsSyncDomain(recordingObserver("test-track-a", calls));
    const stop = trackDomainEdits(sync);
    const unregisterB = registerSettingsSyncDomain(recordingObserver("test-track-b", calls));
    const unregisterC = registerSettingsSyncDomain(recordingObserver("test-track-c", calls));
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
    const unregisterA = registerSettingsSyncDomain(recordingObserver("test-fail-a", calls));
    const unregisterBroken = registerSettingsSyncDomain({
      id: "test-fail-broken",
      observeEdits: () => {
        throw new Error("committer unavailable");
      },
    });
    try {
      expect(() => trackDomainEdits(sync)).toThrow("committer unavailable");
    } finally {
      unregisterA();
      unregisterBroken();
    }
    expect(calls).toEqual(["start test-fail-a", "stop test-fail-a"]);
  });
});
