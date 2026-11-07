import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { DEFAULT_CLIENT_SETTINGS } from "@/hooks/use-settings/storage";
import { createSyncedAppSettingsSave } from "./app-edits";
import { SettingsSyncModel } from "./model";

/** A model whose durable local writes fail on demand. */
function deviceOnlyModel() {
  const writes = { fail: false };
  const model = new SettingsSyncModel({
    readLocal: async () => null,
    writeLocal: async () => {
      if (writes.fail) throw new Error("disk full");
    },
    getDeviceValues: async () => ({}),
    applyValues: async () => {},
  });
  return { model, writes };
}

describe("device-only app settings saves", () => {
  it("takes the ordinary local path when a save arrives before sync state loads", async () => {
    const { model } = deviceOnlyModel();
    const save = createSyncedAppSettingsSave({
      model,
      loadSettings: async () => DEFAULT_CLIENT_SETTINGS,
    });
    expect(model.getState().status).toBe("loading");

    // false hands the write back to ordinary local storage.
    await expect(save(new QueryClient(), { theme: "light" })).resolves.toBe(false);
    expect(model.getState()).toMatchObject({ status: "local", selectedHost: null });
  });

  it("takes the ordinary local path after a failed host selection leaves no host", async () => {
    const { model, writes } = deviceOnlyModel();
    await model.load();
    writes.fail = true;
    await expect(model.selectHost("A")).rejects.toThrow("disk full");
    expect(model.getState()).toMatchObject({ status: "error", selectedHost: null });

    const save = createSyncedAppSettingsSave({
      model,
      loadSettings: async () => DEFAULT_CLIENT_SETTINGS,
    });
    await expect(save(new QueryClient(), { theme: "light" })).resolves.toBe(false);
  });
});
