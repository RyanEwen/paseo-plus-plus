import {
  NotificationAcknowledgementSchema,
  NotificationReceipts,
} from "@getpaseo/protocol/notification-receipts";
import { WorkspaceNotificationSynchronizer } from "../notifications/workspace-receipts";
import type {
  NotificationAcknowledgement,
  NotificationDismissal,
} from "@getpaseo/protocol/notification-receipts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendWorkspaceOsNotification } from "@/notifications/workspace-notification";
import type { OsNotificationPayload } from "./os-notifications";

describe("Workspace notification enrichment", () => {
  const payload = {
    title: "Workspace",
    body: "Agent finished\nDone",
    data: { serverId: "host", workspaceId: "workspace", agentId: "agent" },
  };

  it("delivers the original alert once when icon lookup rejects", async () => {
    const sent: OsNotificationPayload[] = [];
    expect(
      await sendWorkspaceOsNotification(payload, {
        async getIcon() {
          throw new Error("Host disconnected");
        },
        async send(notification) {
          sent.push(notification);
          return true;
        },
      }),
    ).toBe(true);
    expect(sent).toEqual([payload]);
  });

  it("delivers once after the icon budget and ignores a late lookup result", async () => {
    const sent: OsNotificationPayload[] = [];
    let finishLookup: (icon: string) => void = () => {};
    const icon = new Promise<string>((resolve) => {
      finishLookup = resolve;
    });
    expect(
      await sendWorkspaceOsNotification(payload, {
        getIcon: () => icon,
        async send(notification) {
          sent.push(notification);
          return true;
        },
      }),
    ).toBe(true);
    finishLookup("data:image/png;base64,late");
    await icon;
    expect(sent).toEqual([payload]);
  });

  it("attaches a ready icon while preserving routing and delivery failure", async () => {
    const sent: OsNotificationPayload[] = [];
    expect(
      await sendWorkspaceOsNotification(payload, {
        async getIcon() {
          return "data:image/png;base64,ready";
        },
        async send(notification) {
          sent.push(notification);
          return false;
        },
      }),
    ).toBe(false);
    expect(sent).toEqual([{ ...payload, icon: "data:image/png;base64,ready" }]);
  });
});

interface MockNotificationOptions {
  body?: string;
  data?: Record<string, unknown>;
  icon?: string;
}

interface MockNotificationInstance {
  title: string;
  options?: MockNotificationOptions;
  clickListeners: Array<(event: Event) => void>;
  addEventListener: (event: string, listener: (event: Event) => void) => void;
  close: ReturnType<typeof vi.fn>;
}

interface GlobalSnapshot {
  Notification: unknown;
  CustomEvent: unknown;
  dispatchEvent: unknown;
  focus: unknown;
  location: unknown;
}

const originalGlobals: GlobalSnapshot = {
  Notification: (globalThis as { Notification?: unknown }).Notification,
  CustomEvent: (globalThis as { CustomEvent?: unknown }).CustomEvent,
  dispatchEvent: (globalThis as { dispatchEvent?: unknown }).dispatchEvent,
  focus: (globalThis as { focus?: unknown }).focus,
  location: (globalThis as { location?: unknown }).location,
};

async function loadModuleForPlatform(
  platform: "web" | "ios" | "android",
  options?: {
    desktopHost?: {
      notification?: {
        sendNotification?: (payload: {
          title: string;
          body?: string;
          data?: Record<string, unknown>;
        }) => Promise<boolean>;
      };
    } | null;
  },
) {
  vi.resetModules();
  vi.doMock("react-native", () => ({ Platform: { OS: platform } }));
  vi.doMock("@/desktop/host", () => ({
    getDesktopHost: () => options?.desktopHost ?? null,
  }));
  vi.doMock("expo-asset", () => ({
    Asset: {
      fromModule: vi.fn(() => ({
        uri: "http://localhost:8081/packages/app/assets/images/notification-icon.png",
      })),
    },
  }));
  return import("./os-notifications");
}

function restoreGlobals(): void {
  (globalThis as { Notification?: unknown }).Notification = originalGlobals.Notification;
  (globalThis as { CustomEvent?: unknown }).CustomEvent = originalGlobals.CustomEvent;
  (globalThis as { dispatchEvent?: unknown }).dispatchEvent = originalGlobals.dispatchEvent;
  (globalThis as { focus?: unknown }).focus = originalGlobals.focus;
  (globalThis as { location?: unknown }).location = originalGlobals.location;
}

describe("sendOsNotification", () => {
  beforeEach(() => {
    class MockCustomEvent<T = unknown> {
      type: string;
      detail: T;
      cancelable: boolean;
      defaultPrevented = false;

      constructor(type: string, init?: { detail?: T; cancelable?: boolean }) {
        this.type = type;
        this.detail = (init?.detail ?? null) as T;
        this.cancelable = init?.cancelable ?? false;
      }

      preventDefault(): void {
        if (this.cancelable) {
          this.defaultPrevented = true;
        }
      }
    }

    (globalThis as { CustomEvent?: unknown }).CustomEvent = MockCustomEvent;
    (globalThis as { focus?: unknown }).focus = vi.fn();
  });

  afterEach(() => {
    vi.doUnmock("react-native");
    vi.restoreAllMocks();
    vi.resetModules();
    restoreGlobals();
  });

  it("dispatches a click event that the app can handle", async () => {
    const created: MockNotificationInstance[] = [];

    class MockNotification implements MockNotificationInstance {
      static permission = "granted";
      static requestPermission = vi.fn(async () => "granted");
      clickListeners: Array<(event: Event) => void> = [];
      close = vi.fn();

      constructor(
        public title: string,
        public options?: MockNotificationOptions,
      ) {
        created.push(this);
      }

      addEventListener(event: string, listener: (event: Event) => void): void {
        if (event === "click") {
          this.clickListeners.push(listener);
        }
      }
    }

    const dispatchEvent = vi.fn((event: unknown) => {
      void event;
      return false;
    });
    const assign = vi.fn();

    (globalThis as { Notification?: unknown }).Notification = MockNotification;
    (globalThis as { dispatchEvent?: unknown }).dispatchEvent = dispatchEvent;
    (globalThis as { location?: unknown }).location = { assign };

    const { sendOsNotification, WEB_NOTIFICATION_CLICK_EVENT } = await loadModuleForPlatform("web");

    const sent = await sendOsNotification({
      title: "Agent finished",
      body: "Done",
      data: { serverId: "srv-1", agentId: "agent-1" },
    });

    expect(sent).toBe(true);
    expect(created).toHaveLength(1);

    const clicked = created[0];
    expect(clicked.clickListeners).toHaveLength(1);
    clicked.clickListeners[0]?.({} as Event);

    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    const event = dispatchEvent.mock.calls[0]?.[0] as {
      type?: string;
      detail?: { data?: Record<string, unknown> };
    };
    expect(event?.type).toBe(WEB_NOTIFICATION_CLICK_EVENT);
    expect(event?.detail).toEqual({
      data: { serverId: "srv-1", agentId: "agent-1" },
    });
    expect(assign).not.toHaveBeenCalled();
  });

  it("falls back to route navigation when no listener handles the click", async () => {
    const created: MockNotificationInstance[] = [];

    class MockNotification implements MockNotificationInstance {
      static permission = "granted";
      static requestPermission = vi.fn(async () => "granted");
      clickListeners: Array<(event: Event) => void> = [];
      close = vi.fn();

      constructor(
        public title: string,
        public options?: MockNotificationOptions,
      ) {
        created.push(this);
      }

      addEventListener(event: string, listener: (event: Event) => void): void {
        if (event === "click") {
          this.clickListeners.push(listener);
        }
      }
    }

    const dispatchEvent = vi.fn((event: unknown) => {
      void event;
      return true;
    });
    const assign = vi.fn();

    (globalThis as { Notification?: unknown }).Notification = MockNotification;
    (globalThis as { dispatchEvent?: unknown }).dispatchEvent = dispatchEvent;
    (globalThis as { location?: unknown }).location = { assign };

    const { sendOsNotification } = await loadModuleForPlatform("web");

    await sendOsNotification({
      title: "Agent finished",
      data: {
        serverId: "srv with space",
        workspaceId: "workspace-1",
        agentId: "agent/1",
      },
    });

    const clicked = created[0];
    expect(clicked.clickListeners).toHaveLength(1);
    clicked.clickListeners[0]?.({} as Event);

    expect(assign).toHaveBeenCalledWith(
      "/h/srv%20with%20space/workspace/workspace-1?open=agent%3Aagent%2F1",
    );
  });

  it("returns false when the Notification API is unavailable", async () => {
    (globalThis as { Notification?: unknown }).Notification = undefined;
    const { sendOsNotification } = await loadModuleForPlatform("web");
    const sent = await sendOsNotification({
      title: "Agent finished",
      body: "Done",
      data: { serverId: "srv-1", agentId: "agent-1" },
    });

    expect(sent).toBe(false);
  });

  it("does not attach a click handler when there is no route target", async () => {
    const created: MockNotificationInstance[] = [];

    class MockNotification implements MockNotificationInstance {
      static permission = "granted";
      static requestPermission = vi.fn(async () => "granted");
      clickListeners: Array<(event: Event) => void> = [];
      close = vi.fn();

      constructor(
        public title: string,
        public options?: MockNotificationOptions,
      ) {
        created.push(this);
      }

      addEventListener(event: string, listener: (event: Event) => void): void {
        if (event === "click") {
          this.clickListeners.push(listener);
        }
      }
    }

    (globalThis as { Notification?: unknown }).Notification = MockNotification;
    (globalThis as { dispatchEvent?: unknown }).dispatchEvent = vi.fn();
    (globalThis as { location?: unknown }).location = { assign: vi.fn() };

    const { sendOsNotification } = await loadModuleForPlatform("web");

    const sent = await sendOsNotification({
      title: "Paseo notification test",
      body: "If you can see this, desktop notifications work.",
    });

    expect(sent).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0]?.clickListeners).toHaveLength(0);
  });

  it("uses the desktop notification bridge when available", async () => {
    const sendNotification = vi.fn(async () => true);

    const { sendOsNotification } = await loadModuleForPlatform("web", {
      desktopHost: {
        notification: {
          sendNotification,
        },
      },
    });

    const sent = await sendOsNotification({
      title: "Paseo notification test",
      body: "If you can see this, desktop notifications work.",
      data: { serverId: "srv-1" },
    });

    expect(sent).toBe(true);
    expect(sendNotification).toHaveBeenCalledWith({
      title: "Paseo notification test",
      body: "If you can see this, desktop notifications work.",
      data: { serverId: "srv-1" },
    });
  });
});

describe("Cross-device workspace notification receipts", () => {
  function memoryDevice(
    initial: Array<{ identifier: string; data: Record<string, unknown> }> = [],
  ) {
    const presented = [...initial];
    const dismissed: string[] = [];
    const pending: NotificationDismissal[] = [];
    const confirmed: string[] = [];
    return {
      presented,
      dismissed,
      pending,
      confirmed,
      port: {
        async list() {
          return presented;
        },
        async dismiss(identifier: string) {
          dismissed.push(identifier);
        },
        async pending() {
          return [...pending];
        },
        async acknowledge(ids: string[]) {
          confirmed.push(...ids);
          for (let index = pending.length - 1; index >= 0; index--) {
            if (ids.includes(pending[index].id)) pending.splice(index, 1);
          }
        },
        async subscribe() {
          return () => {};
        },
      },
    };
  }
  function fixture(device = memoryDevice()) {
    const storage = new Map<string, string>();
    const requests: Array<{ workspaceId: string; notification: NotificationAcknowledgement }> = [];
    const errors: unknown[] = [];
    let nextId = 0;
    const ports: ConstructorParameters<typeof WorkspaceNotificationSynchronizer>[0] = {
      serverId: "host",
      device: device.port,
      storage: {
        async getItem(key) {
          return storage.get(key) ?? null;
        },
        async setItem(key, value) {
          storage.set(key, value);
        },
      },
      async acknowledge(workspaceId, notification) {
        requests.push({ workspaceId, notification });
      },
      async resolveAgentWorkspace() {
        return "workspace";
      },
      attention: () => [],
      report: (error) => errors.push(error),
      newId: () => `ack-${++nextId}`,
    };
    const sync = new WorkspaceNotificationSynchronizer(ports);
    return { sync, requests, errors, device, storage, ports };
  }
  function capturedAttention(count: number) {
    return Array.from({ length: count }, (_, index) => ({
      agentId: `captured-${index}`,
      timestamp: "2026-10-26T10:00:00.000Z",
    }));
  }

  it.each(["open", "markRead"] as const)(
    "T59 bounds all 257 captured observations for %s without widening the read",
    async (operation) => {
      const f = fixture();
      const attention = capturedAttention(257);
      f.ports.attention = () => attention;
      await f.sync.start();
      f.sync.accept([{ id: "workspace", notificationReceipts: state(4, 0, "original-read") }]);
      if (operation === "open") f.sync.open("workspace");
      else await f.sync.markRead("workspace");
      await f.sync.flush();
      const stored = JSON.parse(f.storage.get("@paseo:notification-receipts:host")!);
      const persisted = stored.outbox.map((entry: { notification: unknown }) =>
        NotificationAcknowledgementSchema.parse(entry.notification),
      );
      expect(persisted.map((entry: NotificationAcknowledgement) => entry.attention.length)).toEqual(
        [256, 1],
      );
      expect(persisted.flatMap((entry: NotificationAcknowledgement) => entry.attention)).toEqual(
        attention,
      );
      expect(
        new Set(persisted.map((entry: NotificationAcknowledgement) => entry.acknowledgementId))
          .size,
      ).toBe(1);
      for (const entry of persisted) {
        expect(entry).toMatchObject({
          kind: "workspace",
          throughSequence: 4,
          observedReadId: "original-read",
        });
      }
      f.sync.accept([{ id: "workspace", notificationReceipts: state(5, 0, "later-read") }]);
      f.sync.setConnected(true);
      await f.sync.flush();
      expect(f.requests.map((entry) => entry.notification)).toEqual(persisted);
      expect(JSON.parse(f.storage.get("@paseo:notification-receipts:host")!).outbox).toEqual([]);
      f.sync.dispose();
    },
  );

  it("T59 recovers an otherwise-valid oversized head in place and retains following work and legacy capture", async () => {
    const f = fixture();
    const attention = capturedAttention(257);
    const oversized = {
      workspaceId: "workspace",
      notification: {
        kind: "workspace",
        acknowledgementId: "original-operation",
        throughSequence: 4,
        observedReadId: "captured-read",
        attention,
      },
    };
    const event = {
      workspaceId: "other",
      notification: {
        kind: "event",
        acknowledgementId: "following-event",
        sequence: 1,
        attention: [],
      },
    };
    const legacy = [
      {
        identifier: "legacy",
        workspaceId: "workspace",
        capturedReadId: "captured-read",
        data: { serverId: "host", workspaceId: "workspace" },
      },
    ];
    f.storage.set(
      "@paseo:notification-receipts:host",
      JSON.stringify({ outbox: [oversized, event], legacy }),
    );
    await f.sync.start();
    const stored = JSON.parse(f.storage.get("@paseo:notification-receipts:host")!);
    expect(stored.legacy).toEqual(legacy);
    expect(
      stored.outbox.map(
        (entry: { notification: { attention: unknown[] } }) => entry.notification.attention.length,
      ),
    ).toEqual([256, 1, 0]);
    expect(
      stored.outbox
        .slice(0, 2)
        .flatMap(
          (entry: { notification: { attention: unknown[] } }) => entry.notification.attention,
        ),
    ).toEqual(attention);
    expect(stored.outbox[2]).toEqual(event);
    f.ports.acknowledge = async (workspaceId, notification) => {
      NotificationAcknowledgementSchema.parse(notification);
      f.requests.push({ workspaceId, notification });
    };
    f.sync.setConnected(true);
    await f.sync.flush();
    expect(f.requests.map((entry) => entry.notification.acknowledgementId)).toEqual([
      "original-operation",
      "original-operation",
      "following-event",
    ]);
    for (const entry of f.requests.slice(0, 2)) {
      expect(entry.workspaceId).toBe("workspace");
      expect(entry.notification).toMatchObject({
        throughSequence: 4,
        observedReadId: "captured-read",
      });
    }
    expect(JSON.parse(f.storage.get("@paseo:notification-receipts:host")!).legacy).toEqual(legacy);
    f.sync.dispose();
  });

  it("T59 persists the full bounded batch before its first transmission", async () => {
    const f = fixture();
    f.ports.attention = () => capturedAttention(257);
    await f.sync.start();
    f.sync.accept([{ id: "workspace", notificationReceipts: state(4) }]);
    let release!: () => void;
    let signal!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      signal = resolve;
    });
    f.ports.storage.setItem = async (key, value) => {
      signal();
      await gate;
      const document = JSON.parse(value);
      for (const entry of document.outbox)
        NotificationAcknowledgementSchema.parse(entry.notification);
      f.storage.set(key, value);
    };
    f.ports.acknowledge = async (workspaceId, notification) => {
      const durable = JSON.parse(f.storage.get("@paseo:notification-receipts:host")!);
      expect(durable.outbox[0]).toEqual({ workspaceId, notification });
      f.requests.push({ workspaceId, notification });
    };
    try {
      const marked = f.sync.markRead("workspace");
      await entered;
      f.sync.setConnected(true);
      expect(f.requests).toEqual([]);
      release();
      await marked;
      await f.sync.flush();
      expect(f.requests.map((entry) => entry.notification.attention.length)).toEqual([256, 1]);
    } finally {
      release();
      f.sync.dispose();
    }
  });

  it("T59 retains an unsent chunk across failure and restart with the same captured CAS boundary", async () => {
    const f = fixture();
    const attention = capturedAttention(257);
    f.ports.attention = () => attention;
    await f.sync.start();
    f.sync.accept([{ id: "workspace", notificationReceipts: state(4, 0, "captured-read") }]);
    await f.sync.markRead("workspace");
    let attempts = 0;
    const server = new NotificationReceipts(state(5, 0, "captured-read"));
    f.ports.acknowledge = async (workspaceId, notification) => {
      NotificationAcknowledgementSchema.parse(notification);
      attempts++;
      if (attempts > 1) throw new Error("Second chunk rejected before commit");
      server.acknowledge(notification);
      f.requests.push({ workspaceId, notification });
    };
    f.sync.setConnected(true);
    await expect(f.sync.flush()).rejects.toThrow("Second chunk rejected before commit");
    const remaining = JSON.parse(f.storage.get("@paseo:notification-receipts:host")!).outbox;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].notification.attention).toEqual(attention.slice(256));
    const logicalId = f.requests[0].notification.acknowledgementId;
    expect(server.snapshot()).toMatchObject({
      acknowledgedThrough: 4,
      lastWorkspaceReadId: logicalId,
    });
    f.sync.dispose();
    const resumed = fixture();
    resumed.ports.storage.getItem = async (key) => f.storage.get(key) ?? null;
    resumed.ports.storage.setItem = async (key, value) => {
      f.storage.set(key, value);
    };
    resumed.ports.acknowledge = async (workspaceId, notification) => {
      NotificationAcknowledgementSchema.parse(notification);
      server.acknowledge(notification);
      resumed.requests.push({ workspaceId, notification });
    };
    resumed.sync.setConnected(true);
    await resumed.sync.start();
    expect(resumed.requests).toEqual(remaining);
    expect(server.snapshot()).toMatchObject({
      latestSequence: 5,
      acknowledgedThrough: 4,
      lastWorkspaceReadId: logicalId,
    });
    expect(server.includes(5)).toBe(false);
    resumed.sync.dispose();
  });

  it.each(["unknown kind", "bad observation", "oversized event", "missing captured CAS"] as const)(
    "T59 leaves unrecognized stored corruption intact: %s",
    async (corruption) => {
      const f = fixture();
      let kind = "workspace";
      if (corruption === "unknown kind") kind = "future";
      if (corruption === "oversized event") kind = "event";
      const notification = {
        kind,
        acknowledgementId: "original",
        ...(corruption === "oversized event" ? { sequence: 4 } : { throughSequence: 4 }),
        ...(corruption === "missing captured CAS" ? {} : { observedReadId: "captured-read" }),
        attention:
          corruption === "bad observation"
            ? [...capturedAttention(256), { agentId: "", timestamp: "" }]
            : capturedAttention(257),
      };
      const original = JSON.stringify({
        outbox: [{ workspaceId: "workspace", notification }],
        legacy: [],
      });
      f.storage.set("@paseo:notification-receipts:host", original);
      let writes = 0;
      f.ports.storage.setItem = async () => {
        writes++;
      };
      f.sync.setConnected(true);
      await expect(f.sync.start()).rejects.toThrow();
      expect(writes).toBe(0);
      expect(f.requests).toEqual([]);
      expect(f.storage.get("@paseo:notification-receipts:host")).toBe(original);
      f.sync.dispose();
    },
  );

  it("T59 rejects failed repair persistence without sending or replacing the original poison document", async () => {
    const f = fixture();
    const original = JSON.stringify({
      outbox: [
        {
          workspaceId: "workspace",
          notification: {
            kind: "workspace",
            acknowledgementId: "original-repair",
            throughSequence: 4,
            observedReadId: null,
            attention: capturedAttention(257),
          },
        },
      ],
      legacy: [],
    });
    f.storage.set("@paseo:notification-receipts:host", original);
    const writeFailure = new Error("Repaired receipt persistence failed");
    f.ports.storage.setItem = async () => {
      throw writeFailure;
    };
    f.sync.setConnected(true);
    await expect(f.sync.start()).rejects.toBe(writeFailure);
    expect(f.requests).toEqual([]);
    expect(f.storage.get("@paseo:notification-receipts:host")).toBe(original);
    f.sync.dispose();
  });

  it("T59 rejects malformed new captures before they can poison a valid durable head", async () => {
    const f = fixture();
    await f.sync.start();
    f.sync.accept([{ id: "workspace", notificationReceipts: state(4) }]);
    await f.sync.markRead("workspace");
    const original = f.storage.get("@paseo:notification-receipts:host");
    f.ports.attention = () => [{ agentId: "", timestamp: "captured" }];
    await expect(f.sync.markRead("workspace")).rejects.toThrow();
    expect(f.storage.get("@paseo:notification-receipts:host")).toBe(original);
    f.sync.setConnected(true);
    await f.sync.flush();
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0].notification.attention).toEqual([]);
    f.sync.dispose();
  });

  const receipt = (sequence: number, workspaceId = "workspace") => ({
    serverId: "host",
    workspaceId,
    notificationSequence: sequence,
  });
  const state = (
    latestSequence: number,
    acknowledgedThrough = 0,
    lastWorkspaceReadId?: string,
  ) => ({ latestSequence, acknowledgedThrough, dismissedSequences: [], lastWorkspaceReadId });

  it("preserves the activation boundary while startup and newer snapshots are pending", async () => {
    const f = fixture();
    f.sync.open("workspace", state(1));
    f.sync.accept([{ id: "workspace", notificationReceipts: state(2) }]);
    f.sync.setConnected(true);
    await f.sync.start();
    await f.sync.flush();
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0].notification).toMatchObject({ kind: "workspace", throughSequence: 1 });
    f.sync.dispose();
  });

  it("captures one activation boundary offline and never acknowledges later events on reconnect", async () => {
    const f = fixture();
    await f.sync.start();
    f.sync.accept([{ id: "workspace", notificationReceipts: state(1) }]);
    const release = f.sync.open("workspace");
    await f.sync.flush();
    f.sync.accept([{ id: "workspace", notificationReceipts: state(2) }]);
    f.sync.setConnected(true);
    await f.sync.flush();
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0].notification).toMatchObject({ kind: "workspace", throughSequence: 1 });
    f.sync.accept([{ id: "workspace", notificationReceipts: state(3) }]);
    await f.sync.flush();
    expect(f.requests).toHaveLength(1);
    release();
    f.sync.dispose();
  });

  it("fences a connected pump's new head on its write and keeps flush pending through acknowledgement", async () => {
    const f = fixture();
    let releasePending!: () => void;
    let signalPending!: () => void;
    let releaseWrite!: () => void;
    let signalWrite!: () => void;
    let releaseAcknowledgement!: () => void;
    let signalAcknowledgement!: () => void;
    const pendingGate = new Promise<void>((resolve) => {
      releasePending = resolve;
    });
    const pendingStarted = new Promise<void>((resolve) => {
      signalPending = resolve;
    });
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const writeStarted = new Promise<void>((resolve) => {
      signalWrite = resolve;
    });
    const acknowledgementGate = new Promise<void>((resolve) => {
      releaseAcknowledgement = resolve;
    });
    const acknowledgementStarted = new Promise<void>((resolve) => {
      signalAcknowledgement = resolve;
    });
    try {
      await f.sync.start();
      f.sync.accept([{ id: "workspace", notificationReceipts: state(1) }]);
      await f.sync.flush();
      f.ports.device.pending = async () => {
        signalPending();
        await pendingGate;
        return [];
      };
      f.sync.setConnected(true);
      await pendingStarted;

      let writes = 0;
      f.ports.storage.setItem = async (key, value) => {
        writes++;
        if (writes === 1) {
          signalWrite();
          await writeGate;
        }
        f.storage.set(key, value);
      };
      f.ports.acknowledge = async (workspaceId, notification) => {
        f.requests.push({ workspaceId, notification });
        signalAcknowledgement();
        await acknowledgementGate;
      };
      const marked = f.sync.markRead("workspace");
      await writeStarted;
      let flushed = false;
      const flush = f.sync.flush().then(() => {
        flushed = true;
        return true;
      });
      releasePending();
      // Let pending()'s resolved continuation reach the held head, without advancing a clock.
      await new Promise<void>((resolve) => {
        queueMicrotask(resolve);
      });
      expect(f.requests).toEqual([]);
      expect(flushed).toBe(false);

      releaseWrite();
      await acknowledgementStarted;
      expect(f.requests).toHaveLength(1);
      expect(flushed).toBe(false);
      releaseAcknowledgement();
      await Promise.all([marked, flush]);
      expect(flushed).toBe(true);
      const document = JSON.parse(f.storage.get("@paseo:notification-receipts:host")!);
      expect(document.outbox).toEqual([]);

      const writeFailure = new Error("Receipt write failed");
      f.ports.storage.setItem = async () => {
        throw writeFailure;
      };
      const failedMark = f.sync.markRead("workspace");
      const failedFlush = f.sync.flush();
      await Promise.all([
        expect(failedMark).rejects.toBe(writeFailure),
        expect(failedFlush).rejects.toBe(writeFailure),
      ]);
      await expect(f.sync.flush()).rejects.toBe(writeFailure);
      expect(f.requests).toHaveLength(1);
    } finally {
      releasePending();
      releaseWrite();
      releaseAcknowledgement();
      f.sync.dispose();
    }
  });

  it("accepts a complete hidden-workspace baseline beyond page one while retaining newer alerts and a pending native dismissal until acknowledgement", async () => {
    const device = memoryDevice([
      { identifier: "old-hidden", data: receipt(1, "workspace-204") },
      { identifier: "new-hidden", data: receipt(2, "workspace-204") },
      { identifier: "other-workspace", data: receipt(1, "untouched") },
    ]);
    const f = fixture(device);
    f.device.pending.push({ id: "swipe-while-hidden", data: receipt(1, "swiped") });
    let releaseAcknowledgement!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseAcknowledgement = resolve;
    });
    f.ports.acknowledge = async (workspaceId, notification) => {
      f.requests.push({ workspaceId, notification });
      await held;
    };
    f.sync.setConnected(true);
    const started = f.sync.start();
    try {
      await expect.poll(() => f.requests.length).toBe(1);
      const baseline = Array.from({ length: 205 }, (_, index) => ({
        id: `workspace-${index}`,
        notificationReceipts: state(2, 1, "remote-read"),
      }));
      f.sync.accept(baseline);
      const flushed = f.sync.flush();
      expect(f.device.confirmed).toEqual([]);
      expect(f.device.pending.map((entry) => entry.id)).toEqual(["swipe-while-hidden"]);
      releaseAcknowledgement();
      await Promise.all([started, flushed]);
      expect(new Set(device.dismissed)).toEqual(new Set(["old-hidden"]));
      expect(f.device.confirmed).toEqual(["swipe-while-hidden"]);
      expect(f.requests).toEqual([
        {
          workspaceId: "swiped",
          notification: {
            kind: "event",
            acknowledgementId: "swipe-while-hidden",
            sequence: 1,
            attention: [],
          },
        },
      ]);
      expect(f.errors).toEqual([]);
    } finally {
      releaseAcknowledgement();
      f.sync.dispose();
    }
  });

  it("remote catch-up clears matching older deliveries and preserves other workspaces and newer events", async () => {
    const device = memoryDevice([
      { identifier: "old", data: receipt(1) },
      { identifier: "new", data: receipt(2) },
      { identifier: "other", data: receipt(1, "other-workspace") },
    ]);
    const f = fixture(device);
    await f.sync.start();
    f.sync.accept([{ id: "workspace", notificationReceipts: state(2, 1) }]);
    await f.sync.flush();
    expect(new Set(device.dismissed)).toEqual(new Set(["old"]));
    expect(f.requests).toEqual([]);
    f.sync.dispose();
  });

  it("syncs an exact explicit swipe and confirms the device outbox only after server success", async () => {
    const f = fixture();
    f.device.pending.push({ id: "native-swipe", data: receipt(1) });
    await f.sync.start();
    expect(f.device.confirmed).toEqual([]);
    f.sync.setConnected(true);
    await f.sync.flush();
    expect(f.requests[0]).toEqual({
      workspaceId: "workspace",
      notification: {
        kind: "event",
        acknowledgementId: "native-swipe",
        sequence: 1,
        attention: [],
      },
    });
    expect(f.device.confirmed).toContain("native-swipe");
    f.sync.dispose();
  });

  it("clears an exact Expo receipt without inferring ownership from Firebase display text", async () => {
    const device = memoryDevice([
      {
        identifier: "FCM-Notification:274217948",
        data: { "android.title": "Workspace", "android.text": "Agent finished" },
      },
      { identifier: "expo-A", data: receipt(1) },
      { identifier: "expo-A-newer", data: receipt(2) },
      { identifier: "expo-B", data: receipt(1, "other-workspace") },
    ]);
    const f = fixture(device);
    await f.sync.start();
    f.sync.accept([
      { id: "workspace", notificationReceipts: state(2, 1, "read-on-Windows") },
      { id: "other-workspace", notificationReceipts: state(1) },
    ]);
    await f.sync.flush();
    expect(new Set(device.dismissed)).toEqual(new Set(["expo-A"]));
    expect(f.requests).toEqual([]);
    expect(f.errors).toEqual([]);
    f.sync.dispose();
  });

  it("retained or merely mounted workspaces do not acknowledge snapshots", async () => {
    const f = fixture();
    await f.sync.start();
    f.sync.setConnected(true);
    f.sync.accept([{ id: "workspace", notificationReceipts: state(2) }]);
    await f.sync.flush();
    expect(f.requests).toEqual([]);
    f.sync.dispose();
  });

  it("captures only startup legacy IDs and leaves later unidentified notifications alone", async () => {
    const device = memoryDevice([
      { identifier: "legacy-startup", data: { serverId: "host", workspaceId: "workspace" } },
    ]);
    const f = fixture(device);
    f.sync.accept([{ id: "workspace", notificationReceipts: state(0) }]);
    await f.sync.start();
    device.presented.push({
      identifier: "later-unknown",
      data: { serverId: "host", workspaceId: "workspace" },
    });
    f.sync.accept([{ id: "workspace", notificationReceipts: state(0, 0, "opened-elsewhere") }]);
    await f.sync.flush();
    expect(device.dismissed).toContain("legacy-startup");
    expect(device.dismissed).not.toContain("later-unknown");
    f.sync.dispose();
  });
});
