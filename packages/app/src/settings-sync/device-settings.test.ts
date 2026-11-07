import {
  preserveDeviceAppSettings,
  applyDeviceAppSettingsUpdate,
  deviceAppSettingsUpdate,
  type DeviceAppSettingsUpdate,
} from "./device-settings";
import { exportSharedAppSettings } from "./scope";
import { exportSupportedChatPreferences } from "@/appearance/chat-preferences-support";
import { QueryClient } from "@tanstack/react-query";
import {
  APP_SETTINGS_KEY,
  APP_SETTINGS_QUERY_KEY,
  DEFAULT_CLIENT_SETTINGS,
  loadAppSettingsFromStorage,
  normalizeAppSettings,
  saveAppSettings,
  type AppSettings,
  type SettingsDeps,
} from "@/hooks/use-settings/storage";
import { createFakeDesktopBridge, createInMemoryKeyValueStorage } from "@/hooks/use-settings/fakes";
import { createSyncedAppSettingsSave } from "./app-edits";
import { describe, expect, it } from "vitest";
import { SettingsSyncModel } from "./model";
import type { AppSettingsSnapshot } from "@getpaseo/protocol/app-settings";
import { snapshot, deferred, host } from "./test-support";

describe("device-local settings scope", () => {
  function deviceClient(fontSize: number) {
    const client = new QueryClient();
    client.setQueryData(APP_SETTINGS_QUERY_KEY, {
      ...DEFAULT_CLIENT_SETTINGS,
      uiBaseFontSize: fontSize,
      contentFontSize: fontSize + 1,
      uiFontFamily: `font-${fontSize}`,
      contentMaxWidth: fontSize === 15 ? null : 900,
      paseoPlusPlus: {
        ...DEFAULT_CLIENT_SETTINGS.paseoPlusPlus,
        mobileWorkspaceTabs: fontSize === 15,
      },
    });
    const model = new SettingsSyncModel({
      readLocal: async () => null,
      writeLocal: async () => {},
      getDeviceValues: async (purpose) => {
        const app = client.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY)!;
        return { app: purpose === "backup" ? app : exportSharedAppSettings({ ...app }) };
      },
      applyValues: async (values) => {
        client.setQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY, (current) =>
          preserveDeviceAppSettings(normalizeAppSettings(values.app), current!),
        );
      },
    });
    const localSave = async (_query: QueryClient, updates: DeviceAppSettingsUpdate) => {
      client.setQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY, (current) => ({
        ...current!,
        ...applyDeviceAppSettingsUpdate(updates, current!),
      }));
    };
    return {
      client,
      model,
      localSave,
      save: createSyncedAppSettingsSave({
        model,
        loadSettings: async () => client.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY)!,
        saveLocalSettings: localSave,
      }),
    };
  }

  it("keeps phone and desktop fonts and layout independent across host updates and reconnects", async () => {
    const phone = deviceClient(15);
    const desktop = deviceClient(19);
    const remote = host({
      ...snapshot("dark"),
      values: {
        app: {
          ...DEFAULT_CLIENT_SETTINGS,
          theme: "dark",
          uiBaseFontSize: 11,
          contentFontSize: 10,
          uiFontFamily: "remote-font",
          contentMaxWidth: 1200,
          paseoPlusPlus: { ...DEFAULT_CLIENT_SETTINGS.paseoPlusPlus, mobileWorkspaceTabs: false },
        },
      },
    });
    for (const device of [phone, desktop]) {
      await device.model.load();
      await device.model.selectHost("A");
      await device.model.connect("A", remote.transport);
    }
    await phone.save(phone.client, { uiBaseFontSize: 17, theme: "light" });
    await phone.model.flush();
    await desktop.model.receive("A", remote.read());
    await phone.model.connect("A", null);
    await phone.model.connect("A", remote.transport);
    expect(phone.client.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY)).toMatchObject({
      uiBaseFontSize: 17,
      contentFontSize: 16,
      uiFontFamily: "font-15",
      contentMaxWidth: null,
      theme: "light",
      paseoPlusPlus: { mobileWorkspaceTabs: true },
    });
    expect(desktop.client.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY)).toMatchObject({
      uiBaseFontSize: 19,
      contentFontSize: 20,
      uiFontFamily: "font-19",
      contentMaxWidth: 900,
      theme: "light",
      paseoPlusPlus: { mobileWorkspaceTabs: false },
    });
    expect(remote.writes.flatMap((write) => write.patches).map((patch) => patch.path)).toEqual([
      ["app", "theme"],
    ]);
    expect(remote.read().values.app).toMatchObject({
      uiBaseFontSize: 11,
      uiFontFamily: "remote-font",
    });
    phone.client.clear();
    desktop.client.clear();
  });

  it("publishes shared preferences without exporting device fields or platform-specific toggles", async () => {
    const device = deviceClient(15);
    const remote = host(snapshot(null));
    await device.model.load();
    await device.model.selectHost("A");
    await device.model.connect("A", remote.transport);
    await device.model.publishDeviceSettings();
    const paths = remote.writes.flatMap((write) => write.patches).map((patch) => patch.path);
    expect(paths).not.toContainEqual(["app", "uiBaseFontSize"]);
    expect(paths).not.toContainEqual(["app", "paseoPlusPlus", "mobileWorkspaceTabs"]);
    expect(paths).toContainEqual(["app", "sendShortcut"]);
    expect(paths).toContainEqual(["app", "chatDisplay"]);
    expect(paths).toContainEqual(["app", "theme"]);
    expect(paths).toContainEqual(["app", "paseoPlusPlus", "stickyUserPrompts"]);
    device.client.clear();
  });

  it("persists local-only edits with a read-only settings host without creating pending writes", async () => {
    const device = deviceClient(15);
    const remote = host(snapshot("dark"));
    await device.model.load();
    await device.model.selectHost("A");
    await device.model.connect("A", { ...remote.transport, writable: false });
    expect(device.model.getState().status).toBe("readonly");
    await device.save(device.client, { codeFontSize: 18, vimKeybindings: true });
    expect(device.client.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY)).toMatchObject({
      codeFontSize: 18,
      vimKeybindings: true,
    });
    expect(remote.writes).toEqual([]);
    expect(device.model.getState().pendingCount).toBe(0);
    device.client.clear();
  });

  it("does not queue shared changes when their preceding local durable save fails", async () => {
    const device = deviceClient(15);
    const remote = host(snapshot("dark"));
    await device.model.load();
    await device.model.selectHost("A");
    await device.model.connect("A", remote.transport);
    const save = createSyncedAppSettingsSave({
      model: device.model,
      loadSettings: async () => DEFAULT_CLIENT_SETTINGS,
      saveLocalSettings: async () => {
        throw new Error("device write failed");
      },
    });
    await expect(save(device.client, { uiBaseFontSize: 17, theme: "light" })).rejects.toThrow(
      "device write failed",
    );
    expect(remote.writes).toEqual([]);
    expect(device.model.getState().pendingCount).toBe(0);
    device.client.clear();
  });

  it("retires obsolete local outbox edits but keeps shared siblings from ancestor replacements", async () => {
    const remote = host({
      ...snapshot("dark"),
      values: { app: { theme: "dark", paseoPlusPlus: { sidebarActivityChips: false } } },
    });
    let saved: unknown;
    const model = new SettingsSyncModel({
      readLocal: async () => ({
        selectedHost: "A",
        hosts: {
          A: {
            snapshot: snapshot("dark"),
            backup: { app: { theme: "light" } },
            pending: [
              { path: ["app", "uiBaseFontSize"], value: 20, expectedRevision: 1 },
              { path: ["app", "useLegacyTerminalRenderer"], value: true, expectedRevision: 1 },
              {
                path: ["app", "paseoPlusPlus"],
                value: { mobileWorkspaceTabs: false, stickyUserPrompts: false },
                expectedRevision: 1,
              },
              {
                path: ["app", "usage"],
                value: { serverId: "private", displayAs: "tokens" },
                expectedRevision: 1,
              },
              { path: ["sidebar", "modeProfiles"], value: {}, expectedRevision: 1 },
            ],
          },
        },
      }),
      writeLocal: async (value) => {
        saved = structuredClone(value);
      },
      getDeviceValues: async () => ({}),
      applyValues: async () => {},
    });
    await model.load();
    await model.connect("A", remote.transport);
    await model.flush();
    expect(remote.writes.flatMap((write) => write.patches).map((patch) => patch.path)).toEqual([
      ["app", "paseoPlusPlus", "stickyUserPrompts"],
      ["app", "usage", "displayAs"],
      ["sidebar", "modeProfiles"],
    ]);
    expect(remote.writes[0]!.patches).toContainEqual({
      path: ["sidebar", "modeProfiles"],
      value: {},
      expectedRevision: 1,
    });
    expect(remote.read().values.app).toMatchObject({
      paseoPlusPlus: { sidebarActivityChips: false, stickyUserPrompts: false },
      usage: { displayAs: "tokens" },
    });
    expect(model.getState().pendingCount).toBe(0);
    expect(saved).toMatchObject({ hosts: { A: { pending: [] } } });
  });
  it("retains a durable local change when a mixed shared edit is rejected by a read-only host", async () => {
    const device = deviceClient(15);
    const remote = host(snapshot("dark"));
    await device.model.load();
    await device.model.selectHost("A");
    await device.model.connect("A", { ...remote.transport, writable: false });
    await expect(
      device.save(device.client, { uiBaseFontSize: 18, theme: "light" }),
    ).rejects.toThrow("Load the selected host");
    expect(device.client.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY)).toMatchObject({
      uiBaseFontSize: 18,
      theme: "dark",
    });
    expect(remote.writes).toEqual([]);
    device.client.clear();
  });
  it("serializes obsolete-outbox migration before a newer host selection", async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    let saved: unknown;
    let held = false;
    const model = new SettingsSyncModel({
      readLocal: async () => ({
        selectedHost: "A",
        hosts: {
          A: {
            snapshot: snapshot("dark"),
            backup: {},
            pending: [{ path: ["app", "uiBaseFontSize"], value: 20, expectedRevision: 1 }],
          },
        },
      }),
      writeLocal: async (value) => {
        if (!held && value.selectedHost === "A") {
          held = true;
          started.resolve();
          await release.promise;
        }
        saved = structuredClone(value);
      },
      getDeviceValues: async () => ({}),
      applyValues: async () => {},
    });
    const loading = model.load();
    await started.promise;
    const selection = model.selectHost("B");
    release.resolve();
    await Promise.all([loading, selection]);
    expect(saved).toMatchObject({ selectedHost: "B", hosts: { A: { pending: [] } } });
    expect(model.getState().selectedHost).toBe("B");
  });

  it.each(["reading", "unsupported", "error", "empty"] as const)(
    "saves the local part and rejects shared edits while host adoption is %s",
    async (status) => {
      const device = deviceClient(15);
      const remote = host(snapshot(status === "empty" ? null : "dark"));
      const reading = deferred<AppSettingsSnapshot>();
      await device.model.load();
      await device.model.selectHost("A");
      const connecting = device.model.connect("A", {
        ...remote.transport,
        supported: status !== "unsupported",
        read: async () => {
          if (status === "error") throw new Error("host unavailable");
          return status === "reading" ? reading.promise : remote.transport.read();
        },
      });
      if (status !== "reading") await connecting;
      expect(device.model.getState().status).toBe(status);
      await device.save(device.client, { uiBaseFontSize: 17 });
      await expect(
        device.save(device.client, { uiBaseFontSize: 18, theme: "light" }),
      ).rejects.toThrow("Load the selected host");
      expect(device.client.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY)).toMatchObject({
        uiBaseFontSize: 18,
        theme: DEFAULT_CLIENT_SETTINGS.theme,
      });
      expect(device.model.getState().pendingCount).toBe(0);
      expect(remote.writes).toEqual([]);
      reading.resolve(snapshot("dark"));
      await connecting;
      device.client.clear();
    },
  );

  it("keeps backups and shared chat preferences while excluding local publication fields", () => {
    const backup = {
      ...DEFAULT_CLIENT_SETTINGS,
      uiBaseFontSize: 21,
      chatDisplay: "collapseToolCalls",
      sendShortcut: "mod-enter",
      paseoPlusPlus: { ...DEFAULT_CLIENT_SETTINGS.paseoPlusPlus, widerWorkspaceTabs: false },
    };
    const published = exportSharedAppSettings(backup);
    expect(published).not.toHaveProperty("uiBaseFontSize");
    expect(published.paseoPlusPlus).not.toHaveProperty("widerWorkspaceTabs");
    expect(published).toMatchObject({
      chatDisplay: "collapseToolCalls",
      sendShortcut: "mod-enter",
    });
    expect(exportSupportedChatPreferences(published, false, "publish")).not.toHaveProperty(
      "sendShortcut",
    );
    expect(exportSupportedChatPreferences(published, true, "publish")).toMatchObject({
      chatDisplay: "collapseToolCalls",
      sendShortcut: "mod-enter",
    });
    expect(backup.uiBaseFontSize).toBe(21);
    expect(backup.paseoPlusPlus.widerWorkspaceTabs).toBe(false);
    expect(exportSupportedChatPreferences(backup, false, "backup")).toEqual(backup);
  });
});

it("merges a queued device toggle with the newest durable shared fork settings", async () => {
  const backing = createInMemoryKeyValueStorage({
    [APP_SETTINGS_KEY]: JSON.stringify(DEFAULT_CLIENT_SETTINGS),
  });
  let release!: () => void;
  let notifyStarted!: () => void;
  const heldWrite = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  let firstWrite = true;
  const deps: SettingsDeps = {
    desktop: createFakeDesktopBridge(),
    storage: {
      getItem: (key) => backing.getItem(key),
      removeItem: (key) => backing.removeItem(key),
      async setItem(key, value) {
        if (firstWrite) {
          firstWrite = false;
          notifyStarted();
          await heldWrite;
        }
        await backing.setItem(key, value);
      },
    },
  };
  const queryClient = new QueryClient();
  queryClient.setQueryData(APP_SETTINGS_QUERY_KEY, DEFAULT_CLIENT_SETTINGS);
  const remote = saveAppSettings({
    queryClient,
    deps,
    updates: (current) => ({
      paseoPlusPlus: { ...current.paseoPlusPlus, stickyUserPrompts: false },
    }),
  });
  await started;
  const updates = deviceAppSettingsUpdate(DEFAULT_CLIENT_SETTINGS, {
    ...DEFAULT_CLIENT_SETTINGS,
    paseoPlusPlus: { ...DEFAULT_CLIENT_SETTINGS.paseoPlusPlus, widerWorkspaceTabs: false },
  });
  const local = saveAppSettings({
    queryClient,
    deps,
    updates: (current) => applyDeviceAppSettingsUpdate(updates, current),
  });
  release();
  await Promise.all([remote, local]);
  expect((await loadAppSettingsFromStorage(deps)).paseoPlusPlus).toMatchObject({
    stickyUserPrompts: false,
    widerWorkspaceTabs: false,
  });
  queryClient.clear();
});
