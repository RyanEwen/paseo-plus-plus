import { describe, expect, it } from "vitest";
import {
  createViewedToastRegistry,
  viewedToastHistoryActions,
  type ShowableNotification,
  type ViewedToastHistory,
} from "./toast-tracking.js";

const chat = { serverId: "host", agentId: "chat" };

/** A notification that records listeners and lets the test fire "show". */
function fakeNotification(): ShowableNotification & { show(): void } {
  const listeners: Array<() => void> = [];
  return {
    on(_event, listener) {
      listeners.push(listener);
    },
    show() {
      for (const listener of listeners) listener();
    },
  };
}

function trackHarness(options: { viewed: boolean }) {
  const registry = createViewedToastRegistry<ReturnType<typeof fakeNotification>>();
  const notification = fakeNotification();
  const dismissed: unknown[] = [];
  const removed: string[] = [];
  let viewed = options.viewed;
  registry.track({
    notification,
    target: chat,
    notificationId: "toast-1",
    isViewed: () => viewed,
    dismiss: (item) => dismissed.push(item),
    removeViewedLive: async (id) => {
      removed.push(id);
    },
  });
  return {
    registry,
    notification,
    dismissed,
    removed,
    setViewed: (value: boolean) => {
      viewed = value;
    },
  };
}

describe("viewed toast registry", () => {
  it("dismisses and removes a toast from history when its chat is viewed as it shows", () => {
    const harness = trackHarness({ viewed: true });

    harness.notification.show();

    expect(harness.dismissed).toEqual([harness.notification]);
    expect(harness.removed).toEqual(["toast-1"]);
  });

  it("leaves a toast alone when its chat is not viewed as it shows", () => {
    const harness = trackHarness({ viewed: false });

    harness.notification.show();

    expect(harness.dismissed).toEqual([]);
    expect(harness.removed).toEqual([]);
  });

  it("holds a close requested before show until the toast has shown", () => {
    const harness = trackHarness({ viewed: false });
    const [known] = harness.registry.values();

    known.close();
    expect(harness.dismissed).toEqual([]);

    harness.notification.show();
    expect(harness.dismissed).toEqual([harness.notification]);
    expect(harness.removed).toEqual(["toast-1"]);
  });

  it("dismisses an already shown toast as soon as it is closed", () => {
    const harness = trackHarness({ viewed: false });
    harness.notification.show();
    const [known] = harness.registry.values();

    known.close();

    expect(harness.dismissed).toEqual([harness.notification]);
    expect(harness.removed).toEqual([]);
  });

  it("forgets a released notification", () => {
    const harness = trackHarness({ viewed: false });

    harness.registry.forget(harness.notification);

    expect([...harness.registry.values()]).toEqual([]);
  });
});

describe("viewed toast history actions", () => {
  function recordingHistory(): ViewedToastHistory & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      list: async () => {
        calls.push("list");
        return [];
      },
      remove: async () => {
        calls.push("remove");
      },
      removeCurrentLive: async (tag) => {
        calls.push(`removeCurrentLive:${tag}`);
      },
    };
  }

  it("reads history only when this build may read it", async () => {
    const history = recordingHistory();

    const actions = viewedToastHistoryActions({
      platform: "win32",
      canReadHistory: false,
      history,
    });

    await expect(actions.list()).resolves.toEqual([]);
    expect(history.calls).toEqual([]);
  });

  it("removes a viewed live toast on a packaged Windows build", async () => {
    const history = recordingHistory();

    const actions = viewedToastHistoryActions({ platform: "win32", canReadHistory: true, history });
    await actions.removeViewedLive?.("toast-1");

    expect(history.calls).toEqual(["removeCurrentLive:toast-1"]);
  });

  it("has no live removal off Windows", () => {
    const actions = viewedToastHistoryActions({
      platform: "darwin",
      canReadHistory: false,
      history: recordingHistory(),
    });

    expect(actions.removeViewedLive).toBeNull();
  });
});
