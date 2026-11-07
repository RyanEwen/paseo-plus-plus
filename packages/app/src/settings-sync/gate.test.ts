import { settingsSyncGate } from "./gate";
import { normalizeAppSettings } from "@/hooks/use-settings/storage";
import { describe, expect, it } from "vitest";
import { SettingsSyncModel } from "./model";
import type { AppSettingsSnapshot } from "@getpaseo/protocol/app-settings";
import { snapshot, deferred, setup, host } from "./test-support";

/** Read availability as the settings sync gate publishes it. */
const readAvailable = () => settingsSyncGate.getState().readAvailable;

// New read-availability bridge; the SettingsSyncModel and transports are the existing ports.
describe("successful settings read availability", () => {
  it("waits for selected-host adoption and permits readable authority without writes", async () => {
    const { model } = setup();
    const registration = settingsSyncGate.install(async () => false);
    const publish = () =>
      registration.updateReadAvailability({
        hydrated: true,
        generation: model.getGeneration(),
        status: model.getState().status,
      });
    const stop = model.subscribe(publish);
    try {
      expect(readAvailable()).toBe(false);
      await model.load();
      expect(readAvailable()).toBe(true);
      await model.selectHost("A");
      const read = deferred<AppSettingsSnapshot>();
      const a = host(snapshot("dark"));
      const connecting = model.connect("A", {
        ...a.transport,
        writable: false,
        read: () => read.promise,
      });
      expect(readAvailable()).toBe(false);
      read.resolve({
        ...snapshot("dark"),
        values: { app: { theme: "dark", paseoPlusPlus: { previousAgents: false } } },
      });
      await connecting;
      expect(model.getState().status).toBe("readonly");
      expect(readAvailable()).toBe(true);
      expect(
        normalizeAppSettings(model.getSnapshot().values.app).paseoPlusPlus.previousAgents,
      ).toBe(false);
      expect(a.writes).toEqual([]);
      await model.connect("A", null);
      expect(readAvailable()).toBe(true);
      await model.selectHost("B");
      await model.connect("B", {
        ...a.transport,
        read: async () => {
          throw new Error("read failed");
        },
      });
      expect(model.getState().status).toBe("error");
      expect(readAvailable()).toBe(false);
    } finally {
      stop();
      registration.release();
    }
  });

  it("does not turn a failed initial local read or empty host into a readable default", async () => {
    const { model } = setup();
    const registration = settingsSyncGate.install(async () => false);
    try {
      registration.updateReadAvailability({ hydrated: false, generation: 0, status: "local" });
      expect(readAvailable()).toBe(false);
      const failed = new SettingsSyncModel({
        readLocal: async () => {
          throw new Error("saved authority cannot be read");
        },
        writeLocal: async () => {},
        getDeviceValues: async () => ({}),
        applyValues: async () => {},
      });
      await failed.load();
      expect(failed.getState().status).toBe("error");
      registration.updateReadAvailability({
        hydrated: true,
        generation: failed.getGeneration(),
        status: failed.getState().status,
      });
      expect(readAvailable()).toBe(false);
      await model.load();
      await model.selectHost("empty");
      await model.connect("empty", host(snapshot(null)).transport);
      registration.updateReadAvailability({
        hydrated: true,
        generation: model.getGeneration(),
        status: model.getState().status,
      });
      expect(readAvailable()).toBe(false);
    } finally {
      registration.release();
    }
  });

  it("invalidates held reads at a generation change and rejects stale publication and teardown", () => {
    const first = settingsSyncGate.install(async () => false);
    const seen: boolean[] = [];
    // Record each read-availability change, ignoring other gate notifications.
    const stop = settingsSyncGate.subscribe(() => {
      if (seen.at(-1) !== readAvailable()) seen.push(readAvailable());
    });
    try {
      first.updateReadAvailability({ hydrated: true, generation: 1, status: "ready" });
      expect(readAvailable()).toBe(true);
      first.updateReadAvailability({ hydrated: true, generation: 1, status: "error" });
      expect(readAvailable()).toBe(true);
      first.updateReadAvailability({ hydrated: true, generation: 2, status: "error" });
      expect(readAvailable()).toBe(false);
      first.updateReadAvailability({ hydrated: true, generation: 1, status: "ready" });
      expect(readAvailable()).toBe(false);
      const second = settingsSyncGate.install(async () => false);
      try {
        first.updateReadAvailability({ hydrated: true, generation: 3, status: "ready" });
        expect(readAvailable()).toBe(false);
        second.updateReadAvailability({ hydrated: true, generation: 4, status: "readonly" });
        first.release();
        expect(first.isCurrent()).toBe(false);
        expect(second.isCurrent()).toBe(true);
        expect(readAvailable()).toBe(true);
      } finally {
        second.release();
      }
      expect(readAvailable()).toBe(false);
      expect(seen).toEqual([true, false, true, false]);
    } finally {
      stop();
      first.release();
    }
  });
});
