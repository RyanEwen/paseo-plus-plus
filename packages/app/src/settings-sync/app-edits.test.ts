import { QueryClient } from "@tanstack/react-query";
import {
  APP_SETTINGS_QUERY_KEY,
  DEFAULT_CLIENT_SETTINGS,
  normalizeAppSettings,
  type AppSettings,
} from "@/hooks/use-settings/storage";
import { createSyncedAppSettingsSave } from "./app-edits";
import { describe, expect, it } from "vitest";
import { SettingsSyncModel } from "./model";
import { snapshot, deferred, setup, host } from "./test-support";

it("evaluates queued functional app edits against the latest durable settings", async () => {
  const queryClient = new QueryClient();
  const model = new SettingsSyncModel({
    readLocal: async () => null,
    writeLocal: async () => {},
    getDeviceValues: async () => ({ app: DEFAULT_CLIENT_SETTINGS }),
    applyValues: async (values) => {
      queryClient.setQueryData(APP_SETTINGS_QUERY_KEY, normalizeAppSettings(values.app));
    },
  });
  const a = host({
    initialized: true,
    revision: 1,
    values: { app: DEFAULT_CLIENT_SETTINGS },
    fieldRevisions: {},
  });
  await model.load();
  await model.selectHost("A");
  await model.connect("A", a.transport);
  await model.connect("A", null);
  const save = createSyncedAppSettingsSave({
    model,
    loadSettings: async () => DEFAULT_CLIENT_SETTINGS,
  });
  await Promise.all([
    save(queryClient, (current) => ({ autoExpandReasoning: !current.autoExpandReasoning })),
    save(queryClient, (current) => ({ autoExpandReasoning: !current.autoExpandReasoning })),
  ]);
  expect(queryClient.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY)?.autoExpandReasoning).toBe(
    false,
  );
  expect(a.writes).toEqual([]);
  queryClient.clear();
});

it("fences a queued app edit while its old host's local settings are still loading", async () => {
  const queryClient = new QueryClient();
  const loading = deferred<AppSettings>();
  const { model } = setup();
  const a = host(snapshot("dark"));
  const b = host(snapshot("light"));
  await model.load();
  await model.selectHost("A");
  await model.connect("A", a.transport);
  const save = createSyncedAppSettingsSave({ model, loadSettings: () => loading.promise });
  const saving = save(queryClient, { theme: "auto" });
  // Attach rejection handling before resolving the deliberately delayed read.
  const rejected = expect(saving).rejects.toThrow("Settings host changed");
  await model.selectHost("B");
  await model.connect("B", b.transport);
  loading.resolve(DEFAULT_CLIENT_SETTINGS);
  await rejected;
  expect(b.writes).toEqual([]);
  expect(model.getState().selectedHost).toBe("B");
  queryClient.clear();
});

it("syncs Usage display and footer visibility while each client keeps its own report host", async () => {
  const client = new QueryClient();
  client.setQueryData(APP_SETTINGS_QUERY_KEY, {
    ...DEFAULT_CLIENT_SETTINGS,
    usage: { ...DEFAULT_CLIENT_SETTINGS.usage, serverId: "device-host" },
  });
  let saved: unknown = null;
  const model = new SettingsSyncModel({
    readLocal: async () => null,
    writeLocal: async (value) => {
      saved = structuredClone(value);
    },
    getDeviceValues: async () => ({ app: DEFAULT_CLIENT_SETTINGS }),
    applyValues: async (values) => {
      const current = client.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY)!;
      const incoming = normalizeAppSettings(values.app);
      client.setQueryData(APP_SETTINGS_QUERY_KEY, {
        ...incoming,
        usage: { ...incoming.usage, serverId: current.usage.serverId },
      });
    },
  });
  const a = host({
    initialized: true,
    revision: 1,
    values: {
      app: {
        usage: { displayAs: "remaining", pins: null, serverId: "historical-remote-host" },
        sidebarFooterItems: [{ key: "usage", visible: true }],
      },
    },
    fieldRevisions: {},
  });
  await model.load();
  await model.selectHost("A");
  await model.connect("A", a.transport);
  const adopted = client.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY)!;
  expect(adopted.usage).toMatchObject({ displayAs: "remaining", serverId: "device-host" });
  expect(adopted.sidebarFooterItems).toEqual([{ key: "usage", visible: true }]);
  const save = createSyncedAppSettingsSave({
    model,
    loadSettings: async () => DEFAULT_CLIENT_SETTINGS,
    saveLocalUsageHost: async (_query, serverId) => {
      client.setQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY, (current) => ({
        ...current!,
        usage: { ...current!.usage, serverId },
      }));
    },
  });
  await save(client, (current) => ({
    usage: { ...current.usage, serverId: "another-device-host" },
  }));
  expect(a.writes).toEqual([]);
  await save(client, (current) => ({
    usage: { ...current.usage, displayAs: "used" },
    sidebarFooterItems: [{ key: "usage", visible: false }],
  }));
  await model.flush();
  expect(a.writes.flatMap((write) => write.patches).map((patch) => patch.path)).toEqual([
    ["app", "sidebarFooterItems"],
    ["app", "usage", "displayAs"],
  ]);
  expect(client.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY)?.usage.serverId).toBe(
    "another-device-host",
  );
  expect(a.read().values).toMatchObject({
    app: {
      usage: { displayAs: "used", serverId: "historical-remote-host" },
      sidebarFooterItems: [{ key: "usage", visible: false }],
    },
  });
  expect(saved).toMatchObject({ hosts: { A: { pending: [] } } });
  client.clear();
});

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
