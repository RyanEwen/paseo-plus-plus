import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { buildAgentDeepLink } from "@getpaseo/protocol/agent-deep-link";
import { createNotificationDeliveryReceipts } from "./notification-receipt-handlers.js";
import { DesktopNotificationReceipts } from "./notification-receipts.js";
import { buildWindowsAgentNotificationArguments } from "./windows-agent-notification.js";
import type { DeliveredAgentToast } from "./windows-toast-history.js";

type Handler = (event: unknown, input?: unknown) => unknown;

interface FakeNotification {
  id: string;
  close: ReturnType<typeof vi.fn>;
  on(event: "show", listener: () => void): FakeNotification;
}

const publicDeliveries = z.array(
  z.object({ identifier: z.string(), data: z.record(z.string(), z.unknown()) }),
);

function launch(workspaceId: string): string {
  return new URLSearchParams({
    paseoAgent: buildAgentDeepLink({ serverId: "host", agentId: workspaceId }),
    paseoReceipt: JSON.stringify({ serverId: "host", workspaceId, notificationSequence: 1 }),
  }).toString();
}

/** Register the receipt IPC against a real store and an in-memory Notification Center history. */
function createReceiptHarness(directory: string, initialHistory: DeliveredAgentToast[]) {
  const handlers = new Map<string, Handler>();
  const removed: DeliveredAgentToast[] = [];
  const state = { history: initialHistory };
  const receipts = createNotificationDeliveryReceipts<FakeNotification>();
  receipts.register({
    handle: (channel, handler) => handlers.set(channel, handler),
    broadcast: () => {},
    openReceipts: () => new DesktopNotificationReceipts(directory),
    history: {
      list: async () => [...state.history],
      remove: async (selected) => {
        removed.push(...selected);
        state.history = state.history.filter((entry) => !selected.includes(entry));
      },
    },
    release: (notification) => receipts.forget(notification),
  });
  const list = handlers.get("paseo:notification:listDelivered");
  const dismiss = handlers.get("paseo:notification:dismissDelivered");
  if (!list || !dismiss) throw new Error("Notification receipt IPC was not registered");
  return { receipts, state, removed, list, dismiss };
}

function createNotification(id: string): FakeNotification {
  const notification: FakeNotification = { id, close: vi.fn(), on: () => notification };
  return notification;
}

describe("Windows receipt IPC record identity", () => {
  it.each([
    "collision",
    "replacement",
    "live overlap",
    "bare saved tag",
    "current different group",
    "retirement write failure",
  ] as const)("binds returned history identity through the receipt IPC: %s", async (scenario) => {
    const directory = await mkdtemp(join(tmpdir(), "paseo-history-ipc-"));
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
    try {
      if (scenario === "bare saved tag") {
        const saved = new DesktopNotificationReceipts(directory);
        saved.shown("same-tag", {
          serverId: "host",
          workspaceId: "wrong-current-routing",
          notificationSequence: 9,
        });
      }
      const harness = createReceiptHarness(directory, [current, legacy]);
      const { receipts, state, removed, list, dismiss } = harness;

      if (
        scenario === "live overlap" ||
        scenario === "current different group" ||
        scenario === "retirement write failure"
      ) {
        const data = {
          serverId: "host",
          agentId: "live",
          workspaceId: "live",
          notificationSequence: 1,
        };
        const instance = createNotification("live-toast");
        const args = buildWindowsAgentNotificationArguments({ notificationId: instance.id, data });
        if (!args) throw new Error("Live launch arguments missing");
        receipts.retain(instance, { notificationId: instance.id, data, launch: args });
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
        state.history = [nativeCurrent, nativeLegacy];
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
          expect(state.history).toEqual([nativeLegacy]);
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
        return;
      }

      const deliveries = publicDeliveries.parse(await list(undefined));
      const selected = deliveries.find((entry) => entry.data.workspaceId === "legacy-workspace");
      if (!selected) throw new Error("Expected legacy delivery is absent from IPC enumeration");
      if (scenario === "replacement") {
        const replacement = { ...legacy, arguments: launch("replacement-workspace") };
        state.history = [current, replacement];
        await dismiss(undefined, [selected.identifier, "unknown-id", legacy.tag]);
        expect(removed).toEqual([]);
        expect(state.history).toEqual([current, replacement]);
        return;
      }
      await dismiss(undefined, [selected.identifier]);
      expect(removed).toEqual([legacy]);
      expect(state.history).toEqual([current]);
      expect(deliveries).toHaveLength(2);
      expect(new Set(deliveries.map((entry) => entry.identifier)).size).toBe(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("Notification delivery close receipts", () => {
  it("records a user swipe as a pending dismissal and ignores closes the app requested", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paseo-close-receipts-"));
    try {
      const { receipts } = createReceiptHarness(directory, []);
      const data = { serverId: "host", workspaceId: "workspace", notificationSequence: 1 };
      const swiped = createNotification("swiped");
      const closedByApp = createNotification("closed-by-app");
      receipts.retain(swiped, { notificationId: swiped.id, data, launch: null });
      receipts.retain(closedByApp, { notificationId: closedByApp.id, data, launch: null });
      receipts.markProgrammatic(closedByApp);

      expect(receipts.closed(swiped, { notificationId: swiped.id, reason: "userCanceled" })).toBe(
        "acknowledge",
      );
      expect(
        receipts.closed(closedByApp, { notificationId: closedByApp.id, reason: "userCanceled" }),
      ).toBe("release");
      expect(new DesktopNotificationReceipts(directory).pending()).toEqual([
        { id: swiped.id, data },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
