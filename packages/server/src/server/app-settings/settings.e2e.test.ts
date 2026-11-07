import { createSettingsHostTransport } from "../../../../app/src/settings-sync/transport.js";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppSettingsPatch, AppSettingsSnapshot } from "@getpaseo/protocol/app-settings";
import { expect, test } from "vitest";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

/** A connected client of the test daemon, speaking the first protocol with settings sync. */
async function connectTestClient(port: number): Promise<DaemonClient> {
  const client = new DaemonClient({ url: `ws://127.0.0.1:${port}/ws`, appVersion: "0.11.2" });
  await client.connect();
  return client;
}

/** Collect app.settings.changed snapshots from an observer of the host's settings. */
async function observeChanges(client: DaemonClient) {
  const subscription = client.observeAppSettings();
  const initial = await subscription.ready;
  const changes: AppSettingsSnapshot[] = [];
  const stop = subscription.subscribe({
    snapshot: () => {},
    update: (message) => {
      if (message.type === "app.settings.changed") changes.push(message.payload.snapshot);
    },
  });
  const release = async () => {
    stop();
    await subscription.release();
  };
  return { initial: initial.snapshot, changes, release };
}

function leaf(path: string[], value: unknown, expectedRevision: number): AppSettingsPatch {
  return { path, value, expectedRevision };
}

test("a settings host starts empty and live observers see its first durable write", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  const writer = await connectTestClient(daemon.port);
  const observer = await connectTestClient(daemon.port);
  try {
    expect(writer.getLastServerInfoMessage()?.features?.appSettingsSync).toBe(true);
    const observed = await observeChanges(observer);
    expect(observed.initial.initialized).toBe(false);

    const seeded = await writer.patchAppSettings({
      patches: [leaf(["app", "theme"], "dark", 0)],
      initialize: true,
    });

    expect(seeded.conflicts).toEqual([]);
    await expect.poll(() => observed.changes.length).toBe(1);
    expect(observed.changes[0]).toMatchObject({
      initialized: true,
      values: { app: { theme: "dark" } },
    });
    await observed.release();
  } finally {
    await writer.close();
    await observer.close();
    await daemon.close();
  }
}, 60_000);

test("a stale write to the same leaf conflicts and leaves the newer value", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  const first = await connectTestClient(daemon.port);
  const second = await connectTestClient(daemon.port);
  try {
    await first.patchAppSettings({
      patches: [leaf(["app", "theme"], "dark", 0)],
      initialize: true,
    });
    const changed = await second.patchAppSettings({
      patches: [leaf(["app", "theme"], "light", 1)],
    });
    expect(changed.conflicts).toEqual([]);

    const conflict = await first.patchAppSettings({ patches: [leaf(["app", "theme"], "auto", 1)] });

    expect(conflict.conflicts).toEqual([["app", "theme"]]);
    expect((await first.getAppSettings()).snapshot.values).toEqual({ app: { theme: "light" } });
  } finally {
    await first.close();
    await second.close();
    await daemon.close();
  }
}, 60_000);

test("shared footer visibility survives a reconnect and a released observer stops receiving", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  const first = await connectTestClient(daemon.port);
  const second = await connectTestClient(daemon.port);
  try {
    await first.patchAppSettings({
      patches: [leaf(["app", "theme"], "dark", 0)],
      initialize: true,
    });
    const observed = await observeChanges(second);
    // Usage is hidden by default. Its visibility is the shared footer item preference.
    const usageVisible = (visible: boolean) => [{ key: "usage", visible }];
    await first.patchAppSettings({
      patches: [leaf(["app", "sidebarFooterItems"], usageVisible(true), 0)],
    });

    const reloaded = await connectTestClient(daemon.port);
    try {
      expect((await reloaded.getAppSettings()).snapshot.values).toMatchObject({
        app: { sidebarFooterItems: usageVisible(true) },
      });
    } finally {
      await reloaded.close();
    }

    await second.patchAppSettings({
      patches: [leaf(["app", "sidebarFooterItems"], usageVisible(false), 2)],
    });
    expect((await first.getAppSettings()).snapshot.values).toMatchObject({
      app: { sidebarFooterItems: usageVisible(false) },
    });
    await expect.poll(() => observed.changes.length).toBe(2);

    await observed.release();
    await first.patchAppSettings({ patches: [leaf(["app", "language"], "fr", 0)] });
    await first.getAppSettings();
    expect(observed.changes).toHaveLength(2);
  } finally {
    await first.close();
    await second.close();
    await daemon.close();
  }
}, 60_000);

test("settings retry rebinds a failed bootstrap and resumes live changes after storage recovery", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  const reader = await connectTestClient(daemon.port);
  const writer = await connectTestClient(daemon.port);
  const controller = new AbortController();
  // React Native provides abort state/events without the newer convenience method.
  Object.defineProperty(controller.signal, "throwIfAborted", { value: undefined });
  try {
    await writer.patchAppSettings({
      patches: [{ path: ["app", "theme"], value: "dark", expectedRevision: 0 }],
      initialize: true,
    });
    const file = join(daemon.paseoHome, "app-settings.json");
    const original = await readFile(file, "utf8");
    await writeFile(file, "invalid JSON");
    const updates: AppSettingsSnapshot[] = [];
    const transport = createSettingsHostTransport({
      client: reader,
      signal: controller.signal,
      onSnapshot: (snapshot) => {
        updates.push(snapshot);
      },
    });
    await expect(transport.read()).rejects.toThrow();
    await writeFile(file, original);
    expect((await transport.read()).values).toEqual({ app: { theme: "dark" } });
    await writer.patchAppSettings({
      patches: [{ path: ["app", "theme"], value: "light", expectedRevision: 1 }],
    });
    await expect.poll(() => updates.at(-1)?.values).toEqual({ app: { theme: "light" } });
  } finally {
    controller.abort();
    await reader.close();
    await writer.close();
    await daemon.close();
  }
}, 60_000);
