import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentDeepLink } from "@getpaseo/protocol/agent-deep-link";
import {
  DesktopNotificationReceipts,
  notificationHistoryIdentifier,
} from "./notification-receipts.js";

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
