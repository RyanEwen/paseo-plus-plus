import type { AgentDeepLinkTarget } from "@getpaseo/protocol/agent-deep-link";
import { describe, expect, it } from "vitest";
import {
  createSeenAgentNotifications,
  isAgentNotificationViewVisible,
  type PresentedAgentNotification,
} from "./seen-agent";

// The notification adapter represents a real platform tray, not app component internals.

describe("seen chat notification dismissal", () => {
  function platformTray() {
    const removed: string[] = [];
    const views: Array<{ target: AgentDeepLinkTarget | null; revision: number }> = [];
    let list: () => Promise<PresentedAgentNotification[]> = async () => [];
    const errors: unknown[] = [];
    const seen = createSeenAgentNotifications({
      list: () => list(),
      dismiss: async (id) => {
        removed.push(id);
      },
      setViewedTarget: async (target, revision) => {
        views.push({ target, revision });
      },
      onError: (error) => errors.push(error),
    });
    return {
      seen,
      removed,
      views,
      errors,
      setList: (next: typeof list) => {
        list = next;
      },
    };
  }

  it("clears only the viewed host and chat from delivered tray history", async () => {
    const tray = platformTray();
    tray.setList(async () => [
      { identifier: "seen", data: { serverId: "host", agentId: "chat", workspaceId: "workspace" } },
      { identifier: "other-chat", data: { serverId: "host", agentId: "other" } },
      { identifier: "other-host", data: { serverId: "other", agentId: "chat" } },
      { identifier: "workspace-only", data: { serverId: "host", workspaceId: "workspace" } },
      {
        identifier: "terminal",
        data: { serverId: "host", agentId: "chat", workspaceId: "workspace", terminalId: "term" },
      },
    ]);
    await tray.seen.view({ target: { serverId: "host", agentId: "chat" }, isVisible: () => true })
      .settled;
    expect(tray.removed).toEqual(["seen"]);
  });

  it("rejects a history read that completes after rapid tab changes", async () => {
    const tray = platformTray();
    let resolveHistory: (value: PresentedAgentNotification[]) => void = () => {};
    let markListStarted: () => void = () => {};
    const listStarted = new Promise<void>((resolve) => {
      markListStarted = resolve;
    });
    tray.setList(
      () =>
        new Promise((resolve) => {
          resolveHistory = resolve;
          markListStarted();
        }),
    );
    const oldView = tray.seen.view({
      target: { serverId: "host", agentId: "old" },
      isVisible: () => true,
    });
    await listStarted;
    tray.setList(async () => []);
    const newView = tray.seen.view({
      target: { serverId: "host", agentId: "new" },
      isVisible: () => true,
    });
    const released = oldView.release();
    resolveHistory([{ identifier: "old-arrival", data: { serverId: "host", agentId: "old" } }]);
    await Promise.all([oldView.settled, newView.settled, released]);
    expect(tray.removed).toEqual([]);
    expect(tray.seen.isViewed({ serverId: "host", agentId: "new" })).toBe(true);
  });

  it("clears arrivals while the chat remains visible but not after foreground is lost", async () => {
    const tray = platformTray();
    let visible = true;
    const view = tray.seen.view({
      target: { serverId: "host", agentId: "chat" },
      isVisible: () => visible,
    });
    await tray.seen.dismissReceived({
      identifier: "during-view",
      data: { serverId: "host", agentId: "chat" },
    });
    visible = false;
    await tray.seen.dismissReceived({
      identifier: "after-blur",
      data: { serverId: "host", agentId: "chat" },
    });
    await view.release();
    expect(tray.removed).toEqual(["during-view"]);
    expect(tray.views).toEqual([
      { target: { serverId: "host", agentId: "chat" }, revision: 1 },
      { target: null, revision: 2 },
    ]);
  });
  it("refreshes tray cleanup when a compact gesture returns to the chat anchor", async () => {
    const tray = platformTray();
    let settled = false;
    tray.setList(async () => [
      { identifier: "at-rest", data: { serverId: "host", agentId: "chat" } },
    ]);
    const view = tray.seen.view({
      target: { serverId: "host", agentId: "chat" },
      isVisible: () => settled,
    });
    await view.settled;
    expect(tray.seen.isViewed({ serverId: "host", agentId: "chat" })).toBe(false);
    settled = true;
    await tray.seen.refreshVisibility();
    expect(tray.removed).toEqual(["at-rest"]);
    await view.release();
    expect(tray.seen.isViewed({ serverId: "host", agentId: "chat" })).toBe(false);
  });
});

const visibleChat = {
  foreground: true,
  panelVisible: true,
  focused: true,
  ready: true,
  compact: true,
  centerVisible: true,
  centerRequested: true,
};
describe("notification seen visibility", () => {
  it.each([
    "foreground",
    "panelVisible",
    "focused",
    "ready",
    "centerVisible",
    "centerRequested",
  ] as const)("does not acknowledge a chat without %s", (field) => {
    expect(isAgentNotificationViewVisible({ ...visibleChat, [field]: false })).toBe(false);
  });
  it("acknowledges a settled focused chat on mobile and desktop", () => {
    expect(isAgentNotificationViewVisible(visibleChat)).toBe(true);
    expect(
      isAgentNotificationViewVisible({
        ...visibleChat,
        compact: false,
        centerVisible: false,
        centerRequested: false,
      }),
    ).toBe(true);
  });
});
