import {
  preserveDeviceAppSettings,
  applyDeviceAppSettingsUpdate,
  type DeviceAppSettingsUpdate,
} from "./device-settings";
import { exportSharedAppSettings } from "./scope";
import {
  selectChatPreferencesSupport,
  exportSupportedChatPreferences,
} from "@/appearance/chat-preferences-support";
import {
  getSettingsReadAvailable,
  subscribeSettingsReadAvailable,
  installSettingsSyncSaveHandler,
} from "./save-handler";
import { bindSettingsHost } from "./binding";
import { createSettingsHostTransport } from "./transport";
import { ServerInfoStatusPayloadSchema } from "@getpaseo/protocol/messages";
import { QueryClient } from "@tanstack/react-query";
import {
  APP_SETTINGS_QUERY_KEY,
  DEFAULT_CLIENT_SETTINGS,
  normalizeAppSettings,
  type AppSettings,
} from "@/hooks/use-settings/storage";
import { createSyncedAppSettingsSave } from "./app-edits";
import { describe, expect, it } from "vitest";
import { SettingsSyncModel, type SettingsSyncTransport } from "./model";
import type {
  AppSettingsSnapshot,
  AppSettingsPatch,
  AppSettingsPatchInput,
} from "@getpaseo/protocol/app-settings";
import { applySettingsPatches, settingsDiff } from "@getpaseo/protocol/app-settings-values";

function snapshot(theme: string | null, revision = 1): AppSettingsSnapshot {
  return {
    initialized: theme !== null,
    revision: theme === null ? 0 : revision,
    values: theme === null ? {} : { app: { theme } },
    fieldRevisions: theme === null ? {} : { '["app","theme"]': revision },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup() {
  let saved: unknown = null;
  let device: Record<string, unknown> = { app: { theme: "device" } };
  const applied: unknown[] = [];
  const model = new SettingsSyncModel({
    readLocal: async () => saved,
    writeLocal: async (value) => {
      saved = structuredClone(value);
    },
    getDeviceValues: async () => device,
    applyValues: async (values) => {
      device = structuredClone(values);
      applied.push(device);
    },
  });
  return { model, applied, device: () => device, saved: () => saved };
}
function host(initial: AppSettingsSnapshot) {
  let remote = initial;
  const writes: { patches: AppSettingsPatch[]; initialize: boolean }[] = [];
  const transport: SettingsSyncTransport = {
    supported: true,
    writable: true,
    read: async () => structuredClone(remote),
    patch: async ({ patches, initialize = false }) => {
      writes.push({ patches: structuredClone(patches), initialize });
      remote = {
        initialized: true,
        revision: remote.revision + 1,
        values: applySettingsPatches(remote.values, patches),
        fieldRevisions: Object.fromEntries(
          patches.map((patch) => [JSON.stringify(patch.path), remote.revision + 1]),
        ),
      };
      return { snapshot: structuredClone(remote), conflicts: [] };
    },
  };
  return { transport, writes, read: () => remote };
}
async function editTheme(model: SettingsSyncModel, before: string, after: string) {
  await model.edit(
    settingsDiff({ app: { theme: before } }, { app: { theme: after } }, model.getSnapshot()),
  );
}

describe("settings host policy", () => {
  it("reads initialized hosts before adoption and never publishes local settings on selection", async () => {
    const { model, device } = setup();
    const a = host(snapshot("dark"));
    const b = host(snapshot("light"));
    await model.load();
    await model.selectHost("A");
    await model.connect("A", a.transport);
    await model.selectHost("B");
    await model.connect("B", b.transport);
    expect(device()).toEqual({ app: { theme: "light" } });
    expect(a.writes).toEqual([]);
    expect(b.writes).toEqual([]);
  });
  it("keeps offline A edits attached to A through A-to-B-to-A switching", async () => {
    const { model, device, saved } = setup();
    const a = host(snapshot("dark"));
    const b = host(snapshot("light"));
    await model.load();
    await model.selectHost("A");
    await model.connect("A", a.transport);
    await model.connect("A", null);
    await editTheme(model, "dark", "auto");
    await model.selectHost("B");
    await model.connect("B", b.transport);
    expect(b.writes).toEqual([]);
    expect(b.read().values).toEqual({ app: { theme: "light" } });
    expect(saved()).toMatchObject({
      selectedHost: "B",
      hosts: { A: { pending: [{ path: ["app", "theme"], value: "auto" }] } },
    });
    await model.selectHost("A");
    await model.connect("A", a.transport);
    expect(device()).toEqual({ app: { theme: "auto" } });
    expect(a.writes).toHaveLength(1);
    expect(b.writes).toEqual([]);
  });
  it("fences a stale A read while B is selected", async () => {
    const { model, device } = setup();
    const stale = deferred<AppSettingsSnapshot>();
    const a = host(snapshot("dark"));
    const b = host(snapshot("light"));
    await model.load();
    await model.selectHost("A");
    const reading = model.connect("A", { ...a.transport, read: () => stale.promise });
    await model.selectHost("B");
    await model.connect("B", b.transport);
    stale.resolve(snapshot("dark"));
    await reading;
    expect(device()).toEqual({ app: { theme: "light" } });
    expect(model.getState().selectedHost).toBe("B");
    expect(b.writes).toEqual([]);
  });
  it("fences an in-flight A save completion and preserves B without writing it", async () => {
    const { model, device } = setup();
    const completion = deferred<{ snapshot: AppSettingsSnapshot; conflicts: string[][] }>();
    const a = host(snapshot("dark"));
    const b = host(snapshot("light"));
    await model.load();
    await model.selectHost("A");
    await model.connect("A", { ...a.transport, patch: () => completion.promise });
    await editTheme(model, "dark", "auto");
    const saving = model.flush();
    await model.selectHost("B");
    const connectingB = model.connect("B", b.transport);
    completion.resolve({ snapshot: snapshot("auto", 2), conflicts: [] });
    await saving;
    await connectingB;
    expect(device()).toEqual({ app: { theme: "light" } });
    expect(b.writes).toEqual([]);
  });
  it("requires an explicit publish on an empty host and blocks ordinary editing", async () => {
    const { model, device } = setup();
    const empty = host(snapshot(null));
    await model.load();
    await model.selectHost("empty");
    await model.connect("empty", empty.transport);
    expect(model.getState().status).toBe("empty");
    expect(empty.writes).toEqual([]);
    await expect(editTheme(model, "device", "dark")).rejects.toThrow("Load");
    expect(device()).toEqual({ app: { theme: "device" } });
    await model.publishDeviceSettings();
    expect(empty.writes).toEqual([
      {
        initialize: true,
        patches: [{ path: ["app", "theme"], value: "device", expectedRevision: 0 }],
      },
    ]);
  });
  it("does not write after a failed read or against an unsupported host", async () => {
    const { model } = setup();
    const a = host(snapshot("dark"));
    await model.load();
    await model.selectHost("A");
    await model.connect("A", {
      ...a.transport,
      read: async () => {
        throw new Error("read failed");
      },
    });
    expect(model.getState().status).toBe("error");
    await expect(editTheme(model, "device", "light")).rejects.toThrow();
    await model.connect("A", { ...a.transport, supported: false });
    expect(model.getState().status).toBe("unsupported");
    expect(a.writes).toEqual([]);
  });
  it("blocks offline edits on a destination which has not been read", async () => {
    const { model } = setup();
    await model.load();
    await model.selectHost("A");
    await model.connect("A", null);
    await expect(editTheme(model, "device", "dark")).rejects.toThrow("Load");
    expect(model.getState().status).toBe("reading");
  });
  it("surfaces concurrent same-field conflicts, retains the outbox and resolves only explicitly", async () => {
    const { model, saved } = setup();
    const a = host(snapshot("dark"));
    const conflicting = {
      ...a.transport,
      read: async () => snapshot("light", 2),
      patch: async () => ({ snapshot: snapshot("light", 2), conflicts: [["app", "theme"]] }),
    };
    await model.load();
    await model.selectHost("A");
    await model.connect("A", a.transport);
    await model.connect("A", null);
    await editTheme(model, "dark", "auto");
    await model.connect("A", conflicting);
    await model.flush();
    expect(model.getState().status).toBe("conflict");
    expect(saved()).toMatchObject({
      hosts: { A: { pending: [{ value: "auto", expectedRevision: 1 }] } },
    });
    await model.useHostSettings();
    expect(model.getState().pendingCount).toBe(0);
  });
  it("restarts from durable host selection and outbox without seeding the host", async () => {
    const first = setup();
    const a = host(snapshot("dark"));
    await first.model.load();
    await first.model.selectHost("A");
    await first.model.connect("A", a.transport);
    await first.model.connect("A", null);
    await editTheme(first.model, "dark", "auto");
    const second = new SettingsSyncModel({
      readLocal: async () => first.saved(),
      writeLocal: async () => {},
      getDeviceValues: async () => ({ app: { theme: "device" } }),
      applyValues: async () => {},
    });
    await second.load();
    expect(second.getState().selectedHost).toBe("A");
    await second.connect("A", a.transport);
    expect(a.writes).toHaveLength(1);
    expect(a.writes[0]!.initialize).toBe(false);
  });
});

it("blocks writes through a read-only connection and preserves the host", async () => {
  const { model, device } = setup();
  const a = host(snapshot("dark"));
  await model.load();
  await model.selectHost("A");
  await model.connect("A", { ...a.transport, writable: false });
  expect(model.getState().status).toBe("readonly");
  expect(device()).toEqual({ app: { theme: "dark" } });
  await expect(editTheme(model, "dark", "light")).rejects.toThrow();
  expect(a.writes).toEqual([]);
});

it("restores the device backup without writing or deleting a host's pending edits", async () => {
  const { model, device, saved } = setup();
  const a = host(snapshot("dark"));
  await model.load();
  await model.selectHost("A");
  await model.connect("A", a.transport);
  await model.connect("A", null);
  await editTheme(model, "dark", "auto");
  await model.restoreDeviceSettings();
  expect(model.getState().status).toBe("local");
  expect(device()).toEqual({ app: { theme: "device" } });
  expect(a.writes).toEqual([]);
  expect(saved()).toMatchObject({
    selectedHost: null,
    hosts: { A: { pending: [{ value: "auto" }] } },
  });
});

it("reads before resolving conflicts and retains pending edits if that read fails", async () => {
  const { model, saved } = setup();
  const a = host(snapshot("dark"));
  let failRead = false;
  const transport = {
    ...a.transport,
    read: async () => {
      if (failRead) throw new Error("offline");
      return a.read();
    },
  };
  await model.load();
  await model.selectHost("A");
  await model.connect("A", transport);
  await model.connect("A", null);
  await editTheme(model, "dark", "auto");
  failRead = true;
  await model.connect("A", transport);
  await expect(model.useHostSettings()).rejects.toThrow("offline");
  expect(saved()).toMatchObject({ hosts: { A: { pending: [{ value: "auto" }] } } });
  expect(a.writes).toEqual([]);
});

it("rebases a second same-field edit after its own earlier in-flight write", async () => {
  const { model, device } = setup();
  const firstSave = deferred<{ snapshot: AppSettingsSnapshot; conflicts: string[][] }>();
  const a = host(snapshot("dark"));
  let calls = 0;
  const transport = {
    ...a.transport,
    patch: async ({ patches, initialize }: AppSettingsPatchInput) => {
      calls += 1;
      if (calls === 1) return firstSave.promise;
      expect(patches[0]!.expectedRevision).toBe(2);
      return a.transport.patch({ patches, initialize });
    },
  };
  await model.load();
  await model.selectHost("A");
  await model.connect("A", transport);
  await editTheme(model, "dark", "light");
  await editTheme(model, "light", "auto");
  firstSave.resolve({ snapshot: snapshot("light", 2), conflicts: [] });
  await model.flush();
  expect(calls).toBe(2);
  expect(device()).toEqual({ app: { theme: "auto" } });
  expect(model.getState().pendingCount).toBe(0);
});

it("keeps A pending edits and ignores its late save after returning to A from B", async () => {
  const { model, device } = setup();
  const completion = deferred<{ snapshot: AppSettingsSnapshot; conflicts: string[][] }>();
  const a = host(snapshot("dark"));
  const b = host(snapshot("light"));
  await model.load();
  await model.selectHost("A");
  await model.connect("A", { ...a.transport, patch: () => completion.promise });
  await editTheme(model, "dark", "auto");
  await model.selectHost("B");
  const readingB = model.connect("B", b.transport);
  await model.selectHost("A");
  const readingA = model.connect("A", a.transport);
  completion.resolve({ snapshot: snapshot("auto", 2), conflicts: [] });
  await readingB;
  await readingA;
  await model.flush();
  expect(model.getState().selectedHost).toBe("A");
  expect(model.getState().pendingCount).toBe(0);
  expect(device()).toEqual({ app: { theme: "auto" } });
  expect(b.writes).toEqual([]);
});

it("does not project defaults after sync configuration fails to load", async () => {
  const applied: unknown[] = [];
  const model = new SettingsSyncModel({
    readLocal: async () => {
      throw new Error("storage unavailable");
    },
    writeLocal: async () => {},
    getDeviceValues: async () => ({ app: { theme: "dark" } }),
    applyValues: async (value) => {
      applied.push(value);
    },
  });
  await model.load();
  expect(model.getState().status).toBe("error");
  expect(applied).toEqual([]);
});

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

it("retains an explicit initialization candidate if another client initializes the host first", async () => {
  const { model, saved } = setup();
  const a = host(snapshot(null));
  const transport = {
    ...a.transport,
    patch: async () => ({ snapshot: snapshot("other-device"), conflicts: [["app", "theme"]] }),
  };
  await model.load();
  await model.selectHost("A");
  await model.connect("A", transport);
  await model.publishDeviceSettings();
  expect(model.getState().status).toBe("conflict");
  expect(saved()).toMatchObject({
    hosts: {
      A: {
        pending: [{ path: ["app", "theme"], value: "device", expectedRevision: 0 }],
        backup: { app: { theme: "device" } },
      },
    },
  });
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

it("never publishes or sends an edit when the durable outbox write fails", async () => {
  let failWrite = false;
  let applied: Record<string, unknown> = { app: { theme: "device" } };
  const model = new SettingsSyncModel({
    readLocal: async () => null,
    writeLocal: async () => {
      if (failWrite) throw new Error("disk unavailable");
    },
    getDeviceValues: async () => applied,
    applyValues: async (value) => {
      applied = value;
    },
  });
  const a = host(snapshot("dark"));
  await model.load();
  await model.selectHost("A");
  await model.connect("A", a.transport);
  await model.connect("A", null);
  failWrite = true;
  await expect(editTheme(model, "dark", "light")).rejects.toThrow("disk unavailable");
  expect(applied).toEqual({ app: { theme: "dark" } });
  expect(a.writes).toEqual([]);
  expect(model.getState().status).toBe("error");
  failWrite = false;
  await model.connect("A", a.transport);
  await editTheme(model, "dark", "light");
  await model.flush();
  expect(a.writes).toHaveLength(1);
  expect(applied).toEqual({ app: { theme: "light" } });
});

describe("settings bootstrap load ownership", () => {
  it.each(["resolve", "reject"] as const)(
    "ignores an obsolete owner's late %s after the replacement load",
    async (settlement) => {
      const firstRead = deferred<unknown>();
      const secondRead = deferred<unknown>();
      let reads = 0;
      const model = new SettingsSyncModel({
        readLocal: () => (++reads === 1 ? firstRead.promise : secondRead.promise),
        writeLocal: async () => {},
        getDeviceValues: async () => ({}),
        applyValues: async () => {},
      });
      const first = new AbortController();
      const oldLoad = model.load(first.signal);
      first.abort();
      const newLoad = model.load();
      secondRead.resolve({ selectedHost: "H", hosts: {} });
      await newLoad;
      const before = model.getState();
      const emissions: unknown[] = [];
      const stop = model.subscribe(() => emissions.push(model.getState()));
      if (settlement === "resolve") firstRead.resolve({ selectedHost: null, hosts: {} });
      else firstRead.reject(new Error("obsolete read failed"));
      await oldLoad;
      stop();
      expect(model.getState()).toEqual(before);
      expect(model.getState()).toMatchObject({
        selectedHost: "H",
        status: "reading",
        canWrite: false,
      });
      expect(emissions).toEqual([]);
    },
  );
  it("does not let a pending load replace a newer explicit host selection", async () => {
    const pending = deferred<unknown>();
    const model = new SettingsSyncModel({
      readLocal: () => pending.promise,
      writeLocal: async () => {},
      getDeviceValues: async () => ({}),
      applyValues: async () => {},
    });
    const loading = model.load();
    await model.selectHost("chosen");
    pending.resolve({ selectedHost: null, hosts: {} });
    await loading;
    expect(model.getState()).toMatchObject({
      selectedHost: "chosen",
      status: "reading",
      canWrite: false,
    });
  });
});

describe("live settings authority", () => {
  function controlledClient() {
    type Client = Parameters<typeof bindSettingsHost>[0]["client"];
    let info = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "H",
      permissions: ["daemon.read"],
      features: { appSettingsSync: true },
    });
    const listeners = new Set<Parameters<Client["subscribeRawMessages"]>[0]>();
    const observations: { settle(theme?: string): void; released: boolean }[] = [];
    let writes = 0;
    const client: Client = {
      getLastServerInfoMessage: () => info,
      subscribeRawMessages: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      patchAppSettings: async () => {
        writes++;
        return { requestId: "patch", snapshot: snapshot("host"), conflicts: [] };
      },
      observeAppSettings: (options) => {
        const ready = deferred<Awaited<ReturnType<Client["observeAppSettings"]>["ready"]>>();
        const id = String(observations.length);
        const observation = {
          settle: (theme = "host") =>
            ready.resolve({ requestId: id, subscriptionId: id, snapshot: snapshot(theme) }),
          released: false,
        };
        const release = async () => {
          observation.released = true;
          options?.signal?.removeEventListener("abort", abort);
        };
        const abort = () => {
          void release();
        };
        options?.signal?.addEventListener("abort", abort, { once: true });
        observations.push(observation);
        return { subscriptionId: id, ready: ready.promise, subscribe: () => () => {}, release };
      },
    };
    return {
      client,
      observations,
      writes: () => writes,
      listenerCount: () => listeners.size,
      change(writable: boolean, supported = true) {
        info = ServerInfoStatusPayloadSchema.parse({
          ...info,
          permissions: writable ? ["daemon.read", "daemon.manage"] : ["daemon.read"],
          features: { appSettingsSync: supported },
        });
        for (const listener of listeners) listener({ type: "status", payload: info });
      },
    };
  }

  it("rebinds same-client permission changes and immediately gates a revoked writer", async () => {
    const { model } = setup();
    await model.load();
    await model.selectHost("H");
    const h = controlledClient();
    const connections: Promise<void>[] = [];
    const stop = bindSettingsHost({
      client: h.client,
      onSnapshot: (value) => {
        void model.receive("H", value);
      },
      onTransport: (transport) => {
        connections.push(model.connect("H", transport));
      },
    });
    h.observations[0].settle();
    await connections[0];
    expect(model.getState().status).toBe("readonly");
    const beforeRefresh = model.getState().pendingCount;
    h.change(true);
    expect(h.observations[0].released).toBe(true);
    h.observations[1].settle();
    await connections[1];
    expect(model.getState()).toMatchObject({ status: "ready", canWrite: true, selectedHost: "H" });
    expect(model.getState().pendingCount).toBe(beforeRefresh);
    h.change(true);
    expect(h.observations).toHaveLength(2);
    h.change(false);
    expect(model.getState().canWrite).toBe(false);
    h.observations[2].settle();
    await connections[2];
    expect(model.getState().status).toBe("readonly");
    expect(h.writes()).toBe(0);
    stop();
    h.change(true);
    expect(h.listenerCount()).toBe(0);
    expect(h.observations).toHaveLength(3);
    expect(h.observations[2].released).toBe(true);
  });

  it("resamples authority on explicit readonly refresh without publishing settings", async () => {
    const { model } = setup();
    await model.load();
    await model.selectHost("H");
    const h = controlledClient();
    const controller = new AbortController();
    const transport = createSettingsHostTransport({
      client: h.client,
      signal: controller.signal,
      onSnapshot: () => {},
    });
    const first = model.connect("H", transport);
    h.observations[0].settle();
    await first;
    const stillReadonly = model.retry();
    await Promise.resolve();
    h.observations[1].settle();
    await stillReadonly;
    expect(model.getState().status).toBe("readonly");
    h.change(true);
    const recovered = model.retry();
    await Promise.resolve();
    h.observations[2].settle();
    await recovered;
    expect(model.getState()).toMatchObject({
      status: "ready",
      canWrite: true,
      selectedHost: "H",
      pendingCount: 0,
    });
    expect(h.writes()).toBe(0);
    controller.abort();
  });

  it("rejects a replaced read's late completion and retires unsupported observations", async () => {
    const { model, applied } = setup();
    await model.load();
    await model.selectHost("H");
    const h = controlledClient(),
      connections: Promise<void>[] = [];
    const stop = bindSettingsHost({
      client: h.client,
      onSnapshot: (value) => {
        void model.receive("H", value);
      },
      onTransport: (transport) => {
        connections.push(model.connect("H", transport));
      },
    });
    h.change(true);
    h.observations[0].settle("obsolete");
    h.observations[1].settle("current");
    await Promise.all(connections);
    expect(applied).toEqual([{ app: { theme: "current" } }]);
    expect(model.getState().status).toBe("ready");
    h.change(true, false);
    await connections[2];
    expect(model.getState().status).toBe("unsupported");
    expect(h.observations).toHaveLength(2);
    expect(h.observations.every((observation) => observation.released)).toBe(true);
    stop();
  });

  it("keeps adopted authority when bootstrap hydration is requested again", async () => {
    const { model } = setup();
    await model.load();
    await model.selectHost("H");
    const h = host(snapshot("host"));
    await model.connect("H", h.transport);
    const before = model.getState();
    await model.load();
    expect(model.getState()).toBe(before);
    await model.receive("H", snapshot("host", 2));
    expect(model.getState()).toMatchObject({ status: "ready", canWrite: true });
    expect(h.writes).toEqual([]);
  });
  it("recovers local Retry after a failed host selection without discarding another host outbox", async () => {
    const first = setup();
    const remote = host(snapshot("host"));
    await first.model.load();
    await first.model.selectHost("A");
    await first.model.connect("A", remote.transport);
    await first.model.connect("A", null);
    await editTheme(first.model, "host", "pending");
    await first.model.selectHost(null);
    const saved = structuredClone(first.saved());
    let reads = 0;
    const model = new SettingsSyncModel({
      readLocal: async () => {
        reads++;
        return structuredClone(saved);
      },
      writeLocal: async () => {
        throw new Error("disk unavailable");
      },
      getDeviceValues: async () => ({}),
      applyValues: async () => {
        throw new Error("must not adopt settings");
      },
    });
    await model.load();
    await expect(model.selectHost("H")).rejects.toThrow("disk unavailable");
    expect(model.getState().status).toBe("error");
    await model.retry();
    expect(model.getState()).toMatchObject({
      selectedHost: null,
      status: "local",
      canWrite: true,
      error: null,
    });
    expect(reads).toBe(1);
    expect(first.saved()).toEqual(saved);
    expect(remote.writes).toEqual([]);
    expect(saved).toMatchObject({
      hosts: { A: { pending: [{ value: "pending" }], backup: { app: { theme: "device" } } } },
    });
  });

  it("retries storage after the first hydration fails", async () => {
    let reads = 0;
    const model = new SettingsSyncModel({
      readLocal: async () => {
        if (++reads === 1) throw new Error("unavailable");
        return null;
      },
      writeLocal: async () => {},
      getDeviceValues: async () => ({}),
      applyValues: async () => {},
    });
    await model.load();
    expect(model.getState().status).toBe("error");
    await model.retry();
    expect(reads).toBe(2);
    expect(model.getState()).toMatchObject({ status: "local", canWrite: true, error: null });
  });
});

// New read-availability bridge; the SettingsSyncModel and transports are the existing ports.
describe("successful settings read availability", () => {
  it("waits for selected-host adoption and permits readable authority without writes", async () => {
    const { model } = setup();
    const registration = installSettingsSyncSaveHandler(async () => false);
    const publish = () =>
      registration.updateReadAvailability({
        hydrated: true,
        generation: model.getGeneration(),
        status: model.getState().status,
      });
    const stop = model.subscribe(publish);
    try {
      expect(getSettingsReadAvailable()).toBe(false);
      await model.load();
      expect(getSettingsReadAvailable()).toBe(true);
      await model.selectHost("A");
      const read = deferred<AppSettingsSnapshot>();
      const a = host(snapshot("dark"));
      const connecting = model.connect("A", {
        ...a.transport,
        writable: false,
        read: () => read.promise,
      });
      expect(getSettingsReadAvailable()).toBe(false);
      read.resolve({
        ...snapshot("dark"),
        values: { app: { theme: "dark", paseoPlusPlus: { previousAgents: false } } },
      });
      await connecting;
      expect(model.getState().status).toBe("readonly");
      expect(getSettingsReadAvailable()).toBe(true);
      expect(
        normalizeAppSettings(model.getSnapshot().values.app).paseoPlusPlus.previousAgents,
      ).toBe(false);
      expect(a.writes).toEqual([]);
      await model.connect("A", null);
      expect(getSettingsReadAvailable()).toBe(true);
      await model.selectHost("B");
      await model.connect("B", {
        ...a.transport,
        read: async () => {
          throw new Error("read failed");
        },
      });
      expect(model.getState().status).toBe("error");
      expect(getSettingsReadAvailable()).toBe(false);
    } finally {
      stop();
      registration();
    }
  });

  it("does not turn a failed initial local read or empty host into a readable default", async () => {
    const { model } = setup();
    const registration = installSettingsSyncSaveHandler(async () => false);
    try {
      registration.updateReadAvailability({ hydrated: false, generation: 0, status: "local" });
      expect(getSettingsReadAvailable()).toBe(false);
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
      expect(getSettingsReadAvailable()).toBe(false);
      await model.load();
      await model.selectHost("empty");
      await model.connect("empty", host(snapshot(null)).transport);
      registration.updateReadAvailability({
        hydrated: true,
        generation: model.getGeneration(),
        status: model.getState().status,
      });
      expect(getSettingsReadAvailable()).toBe(false);
    } finally {
      registration();
    }
  });

  it("invalidates held reads at a generation change and rejects stale publication and teardown", () => {
    const first = installSettingsSyncSaveHandler(async () => false);
    const seen: boolean[] = [];
    const stop = subscribeSettingsReadAvailable(() => seen.push(getSettingsReadAvailable()));
    try {
      first.updateReadAvailability({ hydrated: true, generation: 1, status: "ready" });
      expect(getSettingsReadAvailable()).toBe(true);
      first.updateReadAvailability({ hydrated: true, generation: 1, status: "error" });
      expect(getSettingsReadAvailable()).toBe(true);
      first.updateReadAvailability({ hydrated: true, generation: 2, status: "error" });
      expect(getSettingsReadAvailable()).toBe(false);
      first.updateReadAvailability({ hydrated: true, generation: 1, status: "ready" });
      expect(getSettingsReadAvailable()).toBe(false);
      const second = installSettingsSyncSaveHandler(async () => false);
      try {
        first.updateReadAvailability({ hydrated: true, generation: 3, status: "ready" });
        expect(getSettingsReadAvailable()).toBe(false);
        second.updateReadAvailability({ hydrated: true, generation: 4, status: "readonly" });
        first();
        expect(first.isCurrent()).toBe(false);
        expect(second.isCurrent()).toBe(true);
        expect(getSettingsReadAvailable()).toBe(true);
      } finally {
        second();
      }
      expect(getSettingsReadAvailable()).toBe(false);
      expect(seen).toEqual([true, false, true, false]);
    } finally {
      stop();
      first();
    }
  });
});

it("chat display uses only the selected settings host capability, preserving device-only choices", () => {
  const capable = ServerInfoStatusPayloadSchema.parse({
    status: "server_info",
    serverId: "capable",
    features: { appSettingsSync: true, appSettingsChatPreferences: true },
  });
  const old = ServerInfoStatusPayloadSchema.parse({
    status: "server_info",
    serverId: "old",
    features: { appSettingsSync: true },
  });
  const state = { sessions: { capable: { serverInfo: capable }, old: { serverInfo: old } } };
  expect(selectChatPreferencesSupport(state, null)).toBe(true);
  expect(selectChatPreferencesSupport(state, "capable")).toBe(true);
  expect(selectChatPreferencesSupport(state, "old")).toBe(false);
  expect(selectChatPreferencesSupport(state, "missing")).toBe(false);
});

it("publishes chat preferences only to a capable settings host while backups and local choices preserve them", () => {
  const app = {
    theme: "dark",
    chatDisplay: "collapseToolCalls",
    sendShortcut: "mod-enter",
    future: { preserved: true },
  };
  expect(exportSupportedChatPreferences(app, false, "publish")).toEqual({
    theme: "dark",
    future: { preserved: true },
  });
  expect(exportSupportedChatPreferences(app, false, "backup")).toEqual(app);
  expect(exportSupportedChatPreferences(app, true, "publish")).toEqual(app);
  expect(
    exportSupportedChatPreferences(
      app,
      selectChatPreferencesSupport({ sessions: {} }, null),
      "publish",
    ),
  ).toEqual(app);
  expect(app.sendShortcut).toBe("mod-enter");
  expect(app.chatDisplay).toBe("collapseToolCalls");
});

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
