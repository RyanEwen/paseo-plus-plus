import { z } from "zod";
import { createWindowsToastHistory } from "./windows-toast-history.js";
import {
  DesktopNotificationReceipts,
  notificationHistoryIdentifier,
} from "./notification-receipts.js";
import { buildAgentDeepLink } from "@getpaseo/protocol/agent-deep-link";
import {
  createViewedAgentNotifications,
  type DeliveredAgentToast,
} from "./viewed-agent-notifications.js";
import { describe, expect, it, vi } from "vitest";
import { cacheNotificationIcon, readNotificationIconBytes } from "./notification-icon.js";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildWindowsAgentToast,
  buildWindowsAgentNotificationArguments,
  openWindowsAgentNotification,
  classifyWindowsNotificationClose,
  createWindowsAgentNotificationOpener,
} from "./windows-agent-notification.js";

describe("Notification project icon boundary", () => {
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1kAAAAASUVORK5CYII=";

  it("reuses content-addressed icon files and repairs corrupt entries without temporary files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paseo-notification-icon-"));
    try {
      const bytes = Buffer.from(png, "base64");
      const iconPath = await cacheNotificationIcon({ directory, bytes });
      expect(await readFile(iconPath)).toEqual(bytes);
      expect(await cacheNotificationIcon({ directory, bytes })).toBe(iconPath);
      await writeFile(iconPath, "interrupted write");
      expect(await cacheNotificationIcon({ directory, bytes })).toBe(iconPath);
      expect(await readFile(iconPath)).toEqual(bytes);
      expect(await readdir(directory)).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("accepts small square PNG bytes and rejects paths, remote URLs and other image types", () => {
    expect(readNotificationIconBytes(`data:image/png;base64,${png}`)).toEqual(
      Buffer.from(png, "base64"),
    );
    for (const input of [
      "https://example.com/icon.png",
      "C:\\icon.png",
      `data:image/svg+xml;base64,${png}`,
      null,
      "data:image/png;base64,YWJj",
    ]) {
      expect(readNotificationIconBytes(input)).toBeNull();
    }
  });

  it("rejects oversized encoded input and pixel dimensions before image decoding", () => {
    expect(readNotificationIconBytes(`data:image/png;base64,${"A".repeat(128 * 1024)}`)).toBeNull();
    for (const [width, height] of [
      [129, 129],
      [0, 0],
      [64, 32],
      [0xffffffff, 0xffffffff],
    ]) {
      const bytes = Buffer.from(png, "base64");
      bytes.writeUInt32BE(width, 16);
      bytes.writeUInt32BE(height, 20);
      expect(
        readNotificationIconBytes(`data:image/png;base64,${bytes.toString("base64")}`),
      ).toBeNull();
    }
  });
});

describe("Windows chat notification activation", () => {
  it("carries the chat target independently of the notification object and escapes its display content", () => {
    const toast = buildWindowsAgentToast({
      notificationId: "notice-1",
      title: 'Agent <ready> & "waiting"',
      body: "Ryan's chat",
      data: { serverId: "host/one", agentId: "chat one", workspaceId: "workspace-one" },
      iconPath: "C:\\Paseo & tools\\icon.png",
      silent: true,
    });
    expect(toast).toBe(
      '<toast launch="type=click&amp;tag=notice-1&amp;paseoAgent=paseo%3A%2F%2Fh%2Fhost%252Fone%2Fagent%2Fchat%2520one" activationType="foreground"><visual><binding template="ToastGeneric"><text>Agent &lt;ready&gt; &amp; &quot;waiting&quot;</text><text>Ryan&apos;s chat</text><image placement="appLogoOverride" hint-crop="none" src="C:\\Paseo &amp; tools\\icon.png"/></binding></visual><audio silent="true"/></toast>',
    );

    const links: string[] = [];
    openWindowsAgentNotification(
      {
        type: "click",
        arguments:
          "type=click&tag=notice-1&paseoAgent=paseo%3A%2F%2Fh%2Fhost%252Fone%2Fagent%2Fchat%2520one",
      },
      (url) => links.push(url),
    );
    expect(links).toEqual(["paseo://h/host%2Fone/agent/chat%20one"]);
  });

  it("keeps sound enabled and supports notifications with no body, icon, or workspace", () => {
    expect(
      buildWindowsAgentToast({
        notificationId: "notice-1",
        title: "Finished",
        body: undefined,
        data: { serverId: "host", agentId: "chat" },
        iconPath: null,
        silent: false,
      }),
    ).toBe(
      '<toast launch="type=click&amp;tag=notice-1&amp;paseoAgent=paseo%3A%2F%2Fh%2Fhost%2Fagent%2Fchat" activationType="foreground"><visual><binding template="ToastGeneric"><text>Finished</text></binding></visual></toast>',
    );
  });

  it("classifies Windows close callbacks without acknowledging programmatic or timed-out events", () => {
    expect(classifyWindowsNotificationClose({ reason: "userCanceled", programmatic: false })).toBe(
      "acknowledge",
    );
    expect(classifyWindowsNotificationClose({ reason: "userCanceled", programmatic: true })).toBe(
      "release",
    );
    expect(classifyWindowsNotificationClose({ reason: "timedOut", programmatic: false })).toBe(
      "retain",
    );
    expect(
      classifyWindowsNotificationClose({ reason: "applicationHidden", programmatic: false }),
    ).toBe("release");
    expect(classifyWindowsNotificationClose({ reason: undefined, programmatic: false })).toBe(
      "release",
    );
  });

  it("opens a foreground instance click and a durable activation only once, in either order", () => {
    for (const callbackOrder of [
      ["instance", "activation"],
      ["activation", "instance"],
    ]) {
      const links: string[] = [];
      const open = createWindowsAgentNotificationOpener((url) => links.push(url));
      const activation = {
        type: "click",
        arguments: "type=click&tag=notice-1&paseoAgent=paseo%3A%2F%2Fh%2Fhost%2Fagent%2Fchat",
      };
      const argumentsFromInstance = buildWindowsAgentNotificationArguments({
        notificationId: "notice-1",
        data: { serverId: "host", agentId: "chat" },
      });
      expect(argumentsFromInstance).toBe(activation.arguments);
      if (argumentsFromInstance === null) {
        throw new Error("Valid instance target did not produce activation arguments");
      }
      const instanceClick = { type: "click", arguments: argumentsFromInstance };
      for (const callback of callbackOrder) {
        open(callback === "instance" ? instanceClick : activation);
      }
      expect(links).toEqual(["paseo://h/host/agent/chat"]);
    }
  });

  it("opens instance-only and restart activations, including distinct notices for the same chat", () => {
    const links: string[] = [];
    const open = createWindowsAgentNotificationOpener((url) => links.push(url));
    for (const tag of ["foreground", "notification-center", "after-restart"]) {
      open({
        type: "click",
        arguments: `type=click&tag=${tag}&paseoAgent=paseo%3A%2F%2Fh%2Fhost%2Fagent%2Fchat`,
      });
    }
    expect(links).toEqual([
      "paseo://h/host/agent/chat",
      "paseo://h/host/agent/chat",
      "paseo://h/host/agent/chat",
    ]);
  });

  it("strips invalid XML controls while preserving Unicode and line breaks", () => {
    expect(
      buildWindowsAgentToast({
        notificationId: "notice-1",
        title: "Ready\u0000\u001b",
        body: "Chat 😀\nLine two\uD800",
        data: { serverId: "host", agentId: "chat" },
        iconPath: null,
        silent: false,
      }),
    ).toBe(
      '<toast launch="type=click&amp;tag=notice-1&amp;paseoAgent=paseo%3A%2F%2Fh%2Fhost%2Fagent%2Fchat" activationType="foreground"><visual><binding template="ToastGeneric"><text>Ready</text><text>Chat 😀\nLine two</text></binding></visual></toast>',
    );
  });

  it("does not turn a terminal or permission-test notification into a chat notification", () => {
    for (const data of [
      undefined,
      { serverId: "host", terminalId: "terminal" },
      { serverId: "host", agentId: " " },
    ]) {
      expect(
        buildWindowsAgentToast({
          notificationId: "notice-1",
          title: "Test",
          body: undefined,
          data,
          iconPath: null,
          silent: false,
        }),
      ).toBe(null);
    }
    const links: string[] = [];
    for (const input of [
      { type: "click", arguments: "" },
      { type: "click", arguments: "https://example.com" },
      {
        type: "reply",
        arguments: "type=click&tag=notice-1&paseoAgent=paseo%3A%2F%2Fh%2Fhost%2Fagent%2Fchat",
      },
    ]) {
      openWindowsAgentNotification(input, (url) => links.push(url));
    }
    expect(links).toEqual([]);
  });
});

describe("viewed chat notification history", () => {
  function historyPlatform() {
    let foreground = true;
    let list: () => Promise<DeliveredAgentToast[]> = async () => [];
    const removed: string[] = [];
    const closed: string[] = [];
    const controller = createViewedAgentNotifications({
      canView: (id) => id === 1 && foreground,
      known: () => [
        { target: { serverId: "host", agentId: "chat" }, close: () => closed.push("chat") },
        {
          target: { serverId: "other-host", agentId: "chat" },
          close: () => closed.push("other-host"),
        },
      ],
      list: () => list(),
      remove: async (entries) => {
        removed.push(...entries.map((entry) => entry.tag));
      },
    });
    return {
      controller,
      removed,
      closed,
      setForeground: (value: boolean) => {
        foreground = value;
      },
      setList: (next: typeof list) => {
        list = next;
      },
    };
  }
  function toast(tag: string, host: string, chat: string): DeliveredAgentToast {
    return {
      tag,
      group: "Notifications",
      arguments: new URLSearchParams({
        paseoAgent: buildAgentDeepLink({ serverId: host, agentId: chat }),
      }).toString(),
    };
  }

  it("removes only this host's viewed chat, including historical toasts with no live object", async () => {
    const platform = historyPlatform();
    platform.setList(async () => [
      toast("historical", "host", "chat"),
      toast("other-host", "other-host", "chat"),
      toast("other-chat", "host", "other-chat"),
    ]);
    await platform.controller.setView(1, {
      revision: 1,
      target: { serverId: "host", agentId: "chat" },
    });
    expect(platform.closed).toEqual(["chat"]);
    expect(platform.removed).toEqual(["historical"]);
  });

  it("rejects stale renderer revisions and acknowledgements from another window", async () => {
    const platform = historyPlatform();
    await platform.controller.setView(1, {
      revision: 2,
      target: { serverId: "host", agentId: "other" },
    });
    await platform.controller.setView(1, {
      revision: 1,
      target: { serverId: "host", agentId: "chat" },
    });
    await platform.controller.setView(2, {
      revision: 3,
      target: { serverId: "host", agentId: "chat" },
    });
    expect(platform.controller.isViewed({ serverId: "host", agentId: "chat" })).toBe(false);
    expect(platform.closed).toEqual([]);
  });

  it("does not dismiss history returned after the window is minimized or hidden", async () => {
    const platform = historyPlatform();
    platform.setList(async () => {
      platform.setForeground(false);
      return [toast("late", "host", "chat")];
    });
    await platform.controller.setView(1, {
      revision: 1,
      target: { serverId: "host", agentId: "chat" },
    });
    expect(platform.removed).toEqual([]);
    expect(platform.controller.isViewed({ serverId: "host", agentId: "chat" })).toBe(false);
  });
  it("accepts a fresh renderer revision after that window reloads", async () => {
    const platform = historyPlatform();
    await platform.controller.setView(1, {
      revision: 12,
      target: { serverId: "host", agentId: "other" },
    });
    platform.controller.removeWindow(1);
    await platform.controller.setView(1, {
      revision: 1,
      target: { serverId: "host", agentId: "chat" },
    });
    expect(platform.closed).toEqual(["chat"]);
  });
  it("rejects a history snapshot returned after switching to a different chat", async () => {
    const platform = historyPlatform();
    let deliverHistory: (entries: DeliveredAgentToast[]) => void = () => {};
    platform.setList(
      () =>
        new Promise((resolve) => {
          deliverHistory = resolve;
        }),
    );
    const oldView = platform.controller.setView(1, {
      revision: 1,
      target: { serverId: "host", agentId: "chat" },
    });
    platform.setList(async () => []);
    await platform.controller.setView(1, {
      revision: 2,
      target: { serverId: "host", agentId: "new-chat" },
    });
    deliverHistory([toast("old", "host", "chat"), toast("new", "host", "new-chat")]);
    await oldView;
    expect(platform.removed).toEqual([]);
    expect(platform.controller.isViewed({ serverId: "host", agentId: "new-chat" })).toBe(true);
  });
});

describe("Desktop exact-dismiss outbox", () => {
  it("persists an explicit event across restart and removes only server-confirmed receipts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paseo-dismissal-receipts-"));
    try {
      const data = {
        serverId: "host",
        workspaceId: "workspace",
        agentId: "agent",
        notificationSequence: 2,
        attentionTimestamp: "observed",
      };
      const store = new DesktopNotificationReceipts(directory);
      store.shown("toast-1", data);
      expect(store.pending()).toEqual([]);
      expect(store.dismissed("toast-1")).toBe(true);
      const restarted = new DesktopNotificationReceipts(directory);
      expect(restarted.pending()).toEqual([{ id: "toast-1", data }]);
      restarted.acknowledge(["another-toast"]);
      expect(restarted.pending()).toHaveLength(1);
      restarted.acknowledge(["toast-1"]);
      expect(new DesktopNotificationReceipts(directory).pending()).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retains the pending receipt when an atomic confirmation write fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paseo-dismissal-write-failure-"));
    try {
      const store = new DesktopNotificationReceipts(directory);
      store.shown("toast", { serverId: "host", workspaceId: "workspace", notificationSequence: 1 });
      store.dismissed("toast");
      const file = join(directory, "notification-receipts.json");
      await rm(file);
      await mkdir(file);
      expect(() => store.acknowledge(["toast"])).toThrow();
      expect(store.pending().map((item) => item.id)).toEqual(["toast"]);
      expect((await readdir(directory)).filter((name) => name.includes(".tmp."))).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not infer a user dismissal from missing history and preserves legacy ownership", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paseo-dismissal-history-"));
    try {
      const store = new DesktopNotificationReceipts(directory);
      store.shown("current", {
        serverId: "host",
        workspaceId: "workspace",
        notificationSequence: 1,
      });
      expect(store.history([])).toEqual([]);
      expect(store.pending()).toEqual([]);
      const argumentsValue = new URLSearchParams({
        paseoAgent: buildAgentDeepLink({ serverId: "host", agentId: "legacy-agent" }),
      }).toString();
      expect(
        store.history([
          { namespace: "legacy", tag: "legacy", group: "Notifications", arguments: argumentsValue },
        ]),
      ).toEqual([
        {
          identifier: notificationHistoryIdentifier({
            namespace: "legacy",
            tag: "legacy",
            group: "Notifications",
            arguments: argumentsValue,
          }),
          data: { serverId: "host", agentId: "legacy-agent" },
        },
      ]);
      expect(store.dismissed("legacy")).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

// ROOT supplies the already installed, owned QA executable on its Windows lane.
// This case reads history only; it never installs, registers, sends or removes.
describe("Normally installed Windows notification history", () => {
  it.skipIf(process.platform !== "win32" || !process.env.PASEO_QA_EXECUTABLE)(
    "accepts the owned installer shortcut instead of requiring the fallback AUMID",
    async () => {
      const executable = process.env.PASEO_QA_EXECUTABLE;
      if (!executable) throw new Error("An exact installed QA executable is required");
      const history = createWindowsToastHistory({ executable, isPackagedFork: true });
      await expect(history.list()).resolves.toEqual(expect.any(Array));
    },
  );

  it("preserves unrelated history with a colliding tag while clearing current and legacy chat records", async () => {
    const launch = (serverId: string, agentId: string) =>
      new URLSearchParams({ paseoAgent: buildAgentDeepLink({ serverId, agentId }) }).toString();
    const current = { tag: "collision", group: "Notifications", arguments: launch("host", "chat") };
    const legacy = { tag: "legacy", group: "Notifications", arguments: launch("host", "chat") };
    const unrelated = {
      tag: "collision",
      group: "Notifications",
      arguments: launch("other-host", "chat"),
    };
    const removed: DeliveredAgentToast[] = [];
    const controller = createViewedAgentNotifications({
      canView: () => true,
      known: () => [],
      list: async () => [current, legacy, unrelated],
      remove: async (toasts) => {
        removed.push(...toasts);
      },
    });
    await controller.setView(1, { revision: 1, target: { serverId: "host", agentId: "chat" } });
    expect(removed).toEqual([current, legacy]);
    expect(removed).not.toContain(unrelated);
  });
});

describe("Windows receipt IPC record identity", () => {
  it.each([
    "collision",
    "replacement",
    "live overlap",
    "bare saved tag",
    "current different group",
    "retirement write failure",
  ] as const)("binds returned history identity through actual IPC: %s", async (scenario) => {
    const directory = await mkdtemp(join(tmpdir(), "paseo-history-ipc-"));
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    if (!platform) throw new Error("Process platform descriptor is unavailable");
    type Handler = (event: unknown, input?: unknown) => unknown;
    const handlers = new Map<string, Handler>();
    const launch = (workspaceId: string) =>
      new URLSearchParams({
        paseoAgent: buildAgentDeepLink({ serverId: "host", agentId: workspaceId }),
        paseoReceipt: JSON.stringify({ serverId: "host", workspaceId, notificationSequence: 1 }),
      }).toString();
    const current: DeliveredAgentToast = {
      namespace: "current",
      tag: "same-tag",
      group: "Notifications",
      arguments: launch("current-workspace"),
    };
    const legacy: DeliveredAgentToast = {
      namespace: "legacy",
      tag: "same-tag",
      group: "Notifications",
      arguments: launch("legacy-workspace"),
    };
    let history = [current, legacy];
    const removed: DeliveredAgentToast[] = [];
    const live: Array<{ id: string; close: ReturnType<typeof vi.fn> }> = [];
    try {
      Object.defineProperty(process, "platform", { ...platform, value: "win32" });
      vi.resetModules();
      vi.doMock("../distribution.js", () => ({
        desktopDistribution: {
          isPreview: true,
          windowsAppUserModelId: "sh.paseo.plusplus.desktop",
        },
      }));
      vi.doMock("electron", () => ({
        app: { isPackaged: true, name: "Paseo++", getPath: () => directory, on: vi.fn() },
        BrowserWindow: { getAllWindows: () => [] },
        Notification: class {
          static handleActivation = vi.fn();
          static isSupported = () => true;
          close = vi.fn();
          constructor(input: { id: string }) {
            live.push({ id: input.id, close: this.close });
          }
          on() {
            return this;
          }
          show() {}
        },
        ipcMain: {
          handle: (name: string, handler: Handler) => {
            handlers.set(name, handler);
          },
        },
        nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
      }));
      vi.doMock("../settings/desktop-settings-electron.js", () => ({
        getDesktopSettingsStore: () => ({
          get: async () => ({ notifications: { playSound: true } }),
        }),
      }));
      vi.doMock("./windows-toast-history.js", () => ({
        createWindowsToastHistory: () => ({
          list: async () => [...history],
          remove: async (selected: DeliveredAgentToast[]) => {
            removed.push(...selected);
            const remaining: DeliveredAgentToast[] = [];
            for (const entry of history) {
              if (!selected.includes(entry)) remaining.push(entry);
            }
            history = remaining;
          },
        }),
      }));
      const { registerNotificationHandlers } = await import("./notifications.js");
      if (scenario === "bare saved tag") {
        const saved = new DesktopNotificationReceipts(directory);
        saved.shown("same-tag", {
          serverId: "host",
          workspaceId: "wrong-current-routing",
          notificationSequence: 9,
        });
      }
      registerNotificationHandlers(vi.fn());
      const list = handlers.get("paseo:notification:listDelivered");
      const dismiss = handlers.get("paseo:notification:dismissDelivered");
      if (!list || !dismiss) throw new Error("Actual notification receipt IPC was not registered");
      const publicDeliveries = z.array(
        z.object({ identifier: z.string(), data: z.record(z.string(), z.unknown()) }),
      );
      if (
        scenario === "live overlap" ||
        scenario === "current different group" ||
        scenario === "retirement write failure"
      ) {
        const send = handlers.get("paseo:notification:send");
        if (!send) throw new Error("Send IPC is missing");
        await send(
          { sender: {} },
          {
            title: "QA",
            data: {
              serverId: "host",
              agentId: "live",
              workspaceId: "live",
              notificationSequence: 1,
            },
          },
        );
        const instance = live[0];
        if (!instance) throw new Error("Actual send did not create a notification");
        const args = buildWindowsAgentNotificationArguments({
          notificationId: instance.id,
          data: { serverId: "host", agentId: "live", workspaceId: "live", notificationSequence: 1 },
        });
        if (!args) throw new Error("Live launch arguments missing");
        const nativeCurrent: DeliveredAgentToast = {
          namespace: "current",
          tag: instance.id,
          group: "Notifications",
          arguments: args,
        };
        const nativeLegacy: DeliveredAgentToast = {
          namespace: scenario === "current different group" ? "current" : "legacy",
          tag: instance.id,
          group: scenario === "current different group" ? "OtherGroup" : "Notifications",
          arguments: launch("legacy-workspace"),
        };
        history = [nativeCurrent, nativeLegacy];
        const deliveries = publicDeliveries.parse(await list(undefined));
        expect(deliveries).toHaveLength(2);
        const selected = deliveries.find((item) => item.data.workspaceId === "live");
        const old = deliveries.find((item) => item.data.workspaceId === "legacy-workspace");
        if (!selected || !old) throw new Error("Live and legacy identities were not kept separate");
        if (scenario === "retirement write failure") {
          // Keep the actual store loaded, but replace its rename destination with
          // a nonempty directory so the real atomic persistence operation fails.
          const file = join(directory, "notification-receipts.json");
          const saved = await readFile(file, "utf8");
          await rm(file);
          await mkdir(file);
          const sentinel = join(file, "unrelated-data");
          await writeFile(sentinel, "preserve");
          await expect(dismiss(undefined, [selected.identifier])).rejects.toThrow();
          expect(removed).toEqual([nativeCurrent]);
          expect(history).toEqual([nativeLegacy]);
          expect(instance.close).toHaveBeenCalledTimes(1);
          expect(await readFile(sentinel, "utf8")).toBe("preserve");
          // Restore only the fixture's original persisted bytes. Enumeration
          // must not retain the closed live object or remove the other namespace.
          await rm(file, { recursive: true });
          await writeFile(file, saved);
          const remaining = publicDeliveries.parse(await list(undefined));
          expect(remaining).toHaveLength(1);
          expect(remaining[0]?.identifier).toBe(old.identifier);
          expect(await readFile(file, "utf8")).toBe(saved);
          return;
        }
        const savedBefore = JSON.parse(
          await readFile(join(directory, "notification-receipts.json"), "utf8"),
        );
        await dismiss(undefined, [old.identifier]);
        const savedAfter = JSON.parse(
          await readFile(join(directory, "notification-receipts.json"), "utf8"),
        );
        expect(savedAfter).toEqual(savedBefore);
        expect(savedAfter.shown[instance.id]).toMatchObject({
          workspaceId: "live",
          notificationSequence: 1,
        });
        expect(savedAfter.historyIdentities[instance.id]).toBe(selected.identifier);
        expect(removed).toEqual([nativeLegacy]);
        expect(instance.close).not.toHaveBeenCalled();
        await dismiss(undefined, [selected.identifier]);
        expect(removed).toEqual([nativeLegacy, nativeCurrent]);
        expect(instance.close).toHaveBeenCalledTimes(1);
        const savedFinal = JSON.parse(
          await readFile(join(directory, "notification-receipts.json"), "utf8"),
        );
        expect(savedFinal.shown[instance.id]).toBeUndefined();
        expect(savedFinal.historyIdentities[instance.id]).toBeUndefined();
        expect(publicDeliveries.parse(await list(undefined))).toEqual([]);
      } else {
        const deliveries = publicDeliveries.parse(await list(undefined));
        const selected = deliveries.find((entry) => entry.data.workspaceId === "legacy-workspace");
        if (!selected) throw new Error("Expected legacy delivery is absent from IPC enumeration");
        if (scenario === "replacement") {
          const replacement = { ...legacy, arguments: launch("replacement-workspace") };
          history = [current, replacement];
          await dismiss(undefined, [selected.identifier, "unknown-id", legacy.tag]);
          expect(removed).toEqual([]);
          expect(history).toEqual([current, replacement]);
        } else {
          await dismiss(undefined, [selected.identifier]);
          expect(removed).toEqual([legacy]);
          expect(history).toEqual([current]);
          expect(deliveries).toHaveLength(2);
          expect(new Set(deliveries.map((entry) => entry.identifier)).size).toBe(2);
        }
      }
    } finally {
      Object.defineProperty(process, "platform", platform);
      vi.doUnmock("electron");
      vi.doUnmock("../distribution.js");
      vi.doUnmock("../settings/desktop-settings-electron.js");
      vi.doUnmock("./windows-toast-history.js");
      vi.resetModules();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
