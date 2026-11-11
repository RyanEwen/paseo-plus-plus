import { buildAgentDeepLink } from "@getpaseo/protocol/agent-deep-link";
import { describe, expect, it } from "vitest";
import type { DeliveredAgentToast } from "../windows-toast-history.js";
import { createViewedAgentNotifications } from "./controller.js";

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
      namespace: "current",
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

describe("viewed chat history across toast namespaces", () => {
  it("preserves unrelated history with a colliding tag while clearing current and legacy chat records", async () => {
    const launch = (serverId: string, agentId: string) =>
      new URLSearchParams({ paseoAgent: buildAgentDeepLink({ serverId, agentId }) }).toString();
    const current: DeliveredAgentToast = {
      tag: "collision",
      group: "Notifications",
      namespace: "current",
      arguments: launch("host", "chat"),
    };
    const legacy: DeliveredAgentToast = {
      tag: "legacy",
      group: "Notifications",
      namespace: "legacy",
      arguments: launch("host", "chat"),
    };
    const unrelated: DeliveredAgentToast = {
      tag: "collision",
      group: "Notifications",
      namespace: "current",
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
