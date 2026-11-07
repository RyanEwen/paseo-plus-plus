import { bindSettingsHost } from "./binding";
import { createSettingsHostTransport } from "./transport";
import { ServerInfoStatusPayloadSchema } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import { SettingsSyncModel } from "./model";
import { snapshot, deferred, setup, host, editTheme } from "./test-support";

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
