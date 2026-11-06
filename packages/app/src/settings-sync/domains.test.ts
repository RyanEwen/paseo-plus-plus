import { describe, expect, it } from "vitest";
import { DEFAULT_CLIENT_SETTINGS } from "@/hooks/use-settings/storage";
import {
  applyDomainValues,
  collectDomainDeviceValues,
  filterDomainAppExport,
  initializeDomains,
  listSettingsSyncDomains,
  observeDomainEdits,
  ownedDomainAppKeys,
  registerSettingsSyncDomain,
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

  it("stops edit observers in reverse order, and stops installed ones when an install fails", () => {
    const calls: string[] = [];
    const observer = (id: string): SettingsSyncDomain => ({
      id,
      observeEdits: () => {
        calls.push(`start ${id}`);
        return () => calls.push(`stop ${id}`);
      },
    });

    const stop = observeDomainEdits([observer("a"), observer("b")], sync);
    stop();
    stop();
    expect(calls).toEqual(["start a", "start b", "stop b", "stop a"]);

    calls.length = 0;
    const failing: SettingsSyncDomain = {
      id: "broken",
      observeEdits: () => {
        throw new Error("committer unavailable");
      },
    };
    expect(() => observeDomainEdits([observer("a"), failing], sync)).toThrow(
      "committer unavailable",
    );
    expect(calls).toEqual(["start a", "stop a"]);
  });
});
