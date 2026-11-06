import { describe, expect, it } from "vitest";
import { SYNC_APP_SETTING_KEYS, SYNC_SETTING_DOMAINS } from "./app-settings-keys.js";

/** Keys that identify this device, its host or local trust; none may travel through sync. */
const NEVER_SYNCED = [
  "credentials",
  "serverId",
  "manageBuiltInDaemon",
  "releaseChannel",
  "filePanelAssociations",
];

describe("synced settings key registry", () => {
  it("lists each key once per domain", () => {
    for (const keys of Object.values(SYNC_SETTING_DOMAINS)) {
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it("never registers device identity, host or trust settings", () => {
    for (const keys of Object.values(SYNC_SETTING_DOMAINS)) {
      for (const key of NEVER_SYNCED) expect(keys).not.toContain(key);
    }
  });

  it("registers the Paseo++ preferences object as one app domain key", () => {
    expect(SYNC_APP_SETTING_KEYS).toContain("paseoPlusPlus");
  });
});
