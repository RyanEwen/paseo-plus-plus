import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { observeExtensionTab } from "./tab-observation.js";
import { createExtensionActionBadges } from "./action-badges.js";
import { describe, expect, it, vi } from "vitest";
import { readCommittedTransition } from "./navigation-metadata.js";
import { createNavigationDelivery } from "./navigation-delivery.js";
import type { BrowserExtensionTab } from "./tab-projection.js";
import {
  canReadSensitiveTab,
  describeVisibleExtensionTab,
  describeVisibleExtensionTabChanges,
} from "./tab-access.js";

const id = "a".repeat(32);
const tab: BrowserExtensionTab = {
  id: 21,
  windowId: 3,
  index: 0,
  active: true,
  highlighted: true,
  url: "https://example.com/private",
  title: "Private document",
  incognito: false,
  status: "complete",
};
function extension(manifest: unknown = {}) {
  return { id, manifest };
}

describe("extension tab metadata access", () => {
  it("preserves basic identity and omits sensitive fields without a grant", () => {
    const visible = describeVisibleExtensionTab(extension(), tab);
    expect(visible).toEqual({
      id: 21,
      windowId: 3,
      index: 0,
      active: true,
      highlighted: true,
      incognito: false,
      status: "complete",
    });
    expect(tab.url).toBe("https://example.com/private");
    expect(tab.title).toBe("Private document");
    expect(
      describeVisibleExtensionTabChanges(
        extension(),
        { url: tab.url, title: tab.title, status: "loading" },
        tab,
      ),
    ).toEqual({ status: "loading" });
    expect(describeVisibleExtensionTabChanges(extension(), { title: tab.title }, tab)).toEqual({});
  });

  it("allows explicit tabs permission and own extension documents, but not foreign extension origins", () => {
    expect(describeVisibleExtensionTab(extension({ permissions: ["tabs"] }), tab)).toEqual(tab);
    const owned = { ...tab, url: `chrome-extension://${id}/popup.html?route=login` };
    expect(describeVisibleExtensionTab(extension(), owned)).toEqual(owned);
    expect(
      canReadSensitiveTab(extension(), {
        ...owned,
        url: `chrome-extension://${"b".repeat(32)}/popup.html`,
      }),
    ).toBe(false);
    expect(
      canReadSensitiveTab(extension({ host_permissions: ["<all_urls>"] }), {
        ...owned,
        url: `chrome-extension://${"b".repeat(32)}/popup.html`,
      }),
    ).toBe(false);
  });

  it("matches required host grants by scheme and host while ignoring grant paths", () => {
    const granted = extension({ host_permissions: ["https://*.example.com/only-this-path"] });
    expect(canReadSensitiveTab(granted, tab)).toBe(true);
    expect(canReadSensitiveTab(granted, { ...tab, url: "https://sub.example.com/another" })).toBe(
      true,
    );
    expect(canReadSensitiveTab(granted, { ...tab, url: "http://example.com/private" })).toBe(false);
    expect(canReadSensitiveTab(granted, { ...tab, url: "https://exampleXcom/private" })).toBe(
      false,
    );
    expect(
      canReadSensitiveTab(granted, { ...tab, url: "https://example.com.evil.test/private" }),
    ).toBe(false);
    expect(canReadSensitiveTab(extension({ permissions: ["https://example.com/path"] }), tab)).toBe(
      true,
    );
    expect(
      describeVisibleExtensionTabChanges(granted, { url: tab.url, title: tab.title }, tab),
    ).toEqual({ url: tab.url, title: tab.title });
  });

  it("allows IPv6 pages through wildcard host grants without inventing exact-host matches", () => {
    const ipv6 = { ...tab, url: "https://[::1]:8443/private" };
    expect(canReadSensitiveTab(extension({ host_permissions: ["<all_urls>"] }), ipv6)).toBe(true);
    expect(
      canReadSensitiveTab(extension({ host_permissions: ["https://*/restricted-path"] }), ipv6),
    ).toBe(true);
    expect(canReadSensitiveTab(extension({ host_permissions: ["http://*/*"] }), ipv6)).toBe(false);
    expect(
      canReadSensitiveTab(extension({ host_permissions: ["https://example.com/*"] }), ipv6),
    ).toBe(false);
  });

  it("does not globally grant optional permissions or activeTab", () => {
    const pending = extension({
      permissions: ["activeTab"],
      optional_permissions: ["tabs"],
      optional_host_permissions: ["<all_urls>"],
    });
    expect(canReadSensitiveTab(pending, tab)).toBe(false);
    expect(canReadSensitiveTab(extension(), { ...tab, url: "" })).toBe(false);
    expect(canReadSensitiveTab(extension({ permissions: ["tabs"] }), { ...tab, url: "" })).toBe(
      true,
    );
  });

  it("does not expose browser-internal or opaque page metadata through all-URL host grants", () => {
    const granted = extension({ host_permissions: ["<all_urls>"] });
    for (const url of ["about:blank", "chrome://settings/", "data:text/plain,private"]) {
      expect(canReadSensitiveTab(granted, { ...tab, url })).toBe(false);
    }
  });

  it("redacts metadata after navigating away from a granted host", () => {
    const granted = extension({ host_permissions: ["https://example.com/*"] });
    const moved = {
      ...tab,
      url: "https://another.test/private",
      title: "Another private document",
    };
    expect(
      describeVisibleExtensionTabChanges(
        granted,
        { url: moved.url, title: moved.title, status: "loading" },
        moved,
      ),
    ).toEqual({ status: "loading" });
    expect(describeVisibleExtensionTab(granted, moved)).not.toHaveProperty("url");
  });
});

/** Real observation/store functions share native callback ordering; only the guest event source is synthetic. */
function observedTab(initialStatus: BrowserExtensionTab["status"] = "complete") {
  const contents = new EventEmitter();
  let current = { ...tab, status: initialStatus };
  const updates: Array<{ changes: unknown; tab: BrowserExtensionTab }> = [];
  const badges = createExtensionActionBadges({ hasTab: (tabId) => tabId === tab.id, changed() {} });
  contents.on("did-navigate", () => badges.forgetTab(tab.id));
  const observation = observeExtensionTab({
    contents: Object.assign(contents, { isDestroyed: () => false }) as unknown as WebContents,
    describe: () => current,
    onUpdated(changes, next) {
      updates.push({ changes, tab: next });
      if (changes.status === "loading") {
        badges.request(id, "action.setBadgeText", { tabId: tab.id, text: "fresh" });
      }
    },
  });
  return {
    contents,
    updates,
    badges,
    observation,
    set(patch: Partial<BrowserExtensionTab>) {
      current = { ...current, ...patch };
    },
  };
}

describe("extension tab committed load events", () => {
  it("publishes reload loading after badge reset so a fresh extension count survives", () => {
    const f = observedTab();
    f.badges.request(id, "action.setBadgeText", { tabId: tab.id, text: "previous" });
    f.set({ status: "loading" });
    f.contents.emit("did-start-loading");
    expect(f.updates).toEqual([]);
    expect(f.badges.snapshot(id, tab.id).text).toBe("previous");
    f.contents.emit("did-navigate");
    expect(f.updates.map(({ changes }) => changes)).toEqual([{ status: "loading" }]);
    expect(f.badges.snapshot(id, tab.id).text).toBe("fresh");
    f.set({ status: "complete" });
    f.contents.emit("did-stop-loading");
    expect(f.updates.map(({ changes }) => changes)).toEqual([
      { status: "loading" },
      { status: "complete" },
    ]);
    expect(f.badges.snapshot(id, tab.id).text).toBe("fresh");
    f.observation.detach();
  });

  it("publishes each committed load even when the prior snapshot already says loading", () => {
    const f = observedTab("loading");
    f.contents.emit("did-navigate");
    expect(f.updates.map(({ changes }) => changes)).toEqual([{ status: "loading" }]);
    f.set({ status: "complete" });
    f.contents.emit("did-stop-loading");
    f.contents.emit("did-stop-loading");
    expect(f.updates.map(({ changes }) => changes)).toEqual([
      { status: "loading" },
      { status: "complete" },
    ]);
    f.observation.detach();
  });

  it("does not turn subframe loads into document loads and retains in-page metadata", () => {
    const f = observedTab();
    f.set({ status: "loading" });
    f.contents.emit("did-start-loading");
    f.set({ status: "complete" });
    f.contents.emit("did-stop-loading");
    expect(f.updates).toEqual([]);
    f.set({ url: tab.url + "#section" });
    f.contents.emit("did-navigate-in-page");
    expect(f.updates.map(({ changes }) => changes)).toEqual([{ url: tab.url + "#section" }]);
    f.observation.detach();
    expect(f.contents.listenerCount("did-stop-loading")).toBe(0);
    expect(f.contents.listenerCount("did-navigate-in-page")).toBe(0);
    expect(f.contents.listenerCount("page-title-updated")).toBe(0);
  });
});

/** Controlled native replies execute the product metadata reader, without page or history payloads. */
function navigationReader(
  overrides: { loaderAfter?: string; entryURL?: string; core?: string } = {},
) {
  let frames = 0;
  const commands: string[] = [];
  let current = true;
  return {
    commands,
    retire() {
      current = false;
    },
    options: {
      url: tab.url,
      isCurrent: () => current,
      async send(command: string) {
        commands.push(command);
        if (command === "Page.getNavigationHistory") {
          return {
            currentIndex: 0,
            entries: [
              {
                id: 7,
                url: overrides.entryURL ?? tab.url,
                transitionType: overrides.core ?? "reload",
              },
            ],
          };
        }
        frames += 1;
        return {
          frameTree: {
            frame: {
              id: "frame",
              loaderId: frames === 1 ? "document" : (overrides.loaderAfter ?? "document"),
              url: tab.url,
            },
          },
        };
      },
    },
  };
}

/** Flush only promise continuations; no sleeps or running native app are needed in these lifecycle cases. */
async function flushNavigation() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}
function deferredTransition() {
  let resolve!: (value: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("extension committed navigation metadata", () => {
  it("reads the exact current native entry between stable document loaders and maps start_page", async () => {
    const f = navigationReader();
    await expect(readCommittedTransition(f.options, new AbortController().signal)).resolves.toBe(
      "reload",
    );
    expect(f.commands).toEqual([
      "Page.getFrameTree",
      "Page.getNavigationHistory",
      "Page.getFrameTree",
    ]);
    const normal = navigationReader({ core: "typed" });
    await expect(
      readCommittedTransition(normal.options, new AbortController().signal),
    ).resolves.toBe("typed");
    const start = navigationReader({ core: "auto_toplevel" });
    await expect(
      readCommittedTransition(start.options, new AbortController().signal),
    ).resolves.toBe("start_page");
  });

  it("rejects replacement loaders, unrelated history entries and unsupported core values", async () => {
    await expect(
      readCommittedTransition(
        navigationReader({ loaderAfter: "replacement" }).options,
        new AbortController().signal,
      ),
    ).rejects.toThrow("committed document");
    await expect(
      readCommittedTransition(
        navigationReader({ entryURL: "https://other.test" }).options,
        new AbortController().signal,
      ),
    ).rejects.toThrow("committed document");
    await expect(
      readCommittedTransition(
        navigationReader({ core: "other" }).options,
        new AbortController().signal,
      ),
    ).rejects.toThrow("Unsupported native");
  });

  it("does not continue queued metadata reads after the captured native commit retires", async () => {
    const f = navigationReader();
    const first = f.options.send;
    f.options.send = async (command) => {
      const value = await first(command);
      f.retire();
      return value;
    };
    await expect(readCommittedTransition(f.options, new AbortController().signal)).rejects.toThrow(
      "retired document",
    );
    expect(f.commands).toEqual(["Page.getFrameTree"]);
  });
});

describe("extension navigation publication lifetime", () => {
  it("publishes the captured commit and timestamp before native completion even when the read finishes later", async () => {
    const native = deferredTransition();
    const events: unknown[] = [];
    const failure = vi.fn();
    const delivery = createNavigationDelivery(failure);
    const timeStamp = 73;
    delivery.committed({
      read: () => native.promise,
      canPublish: () => true,
      isCurrent: () => true,
      publish: (transitionType) => events.push({ name: "committed", timeStamp, transitionType }),
    });
    delivery.dispatch(() => events.push({ name: "completed", timeStamp: 74 }));
    expect(events).toEqual([]);
    native.resolve("reload");
    await flushNavigation();
    expect(events).toEqual([
      { name: "committed", timeStamp: 73, transitionType: "reload" },
      { name: "completed", timeStamp: 74 },
    ]);
    expect(failure).not.toHaveBeenCalled();
  });

  it("bounds a hung read, omits failed metadata and ignores its eventual late answer", async () => {
    vi.useFakeTimers();
    try {
      const native = deferredTransition();
      const events: unknown[] = [];
      const failure = vi.fn();
      const delivery = createNavigationDelivery(failure);
      delivery.committed({
        read: () => native.promise,
        canPublish: () => true,
        isCurrent: () => true,
        publish: (transitionType) =>
          events.push(transitionType === undefined ? {} : { transitionType }),
      });
      delivery.dispatch(() => events.push("completed"));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(events).toEqual([{}, "completed"]);
      expect(failure).toHaveBeenCalledTimes(1);
      native.resolve("reload");
      await flushNavigation();
      expect(events).toEqual([{}, "completed"]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes an earlier commit without stale metadata when a new document supersedes its reader", async () => {
    const old = deferredTransition();
    const next = deferredTransition();
    const events: unknown[] = [];
    const delivery = createNavigationDelivery(vi.fn());
    let current = 1;
    delivery.committed({
      read: () => old.promise,
      canPublish: () => true,
      isCurrent: () => current === 1,
      publish: (type) => events.push(["old", type]),
    });
    delivery.dispatch(() => events.push("old-complete"));
    current = 2;
    delivery.committed({
      read: () => next.promise,
      canPublish: () => true,
      isCurrent: () => current === 2,
      publish: (type) => events.push(["new", type]),
    });
    old.resolve("reload");
    next.resolve("typed");
    await flushNavigation();
    expect(events).toEqual([["old", undefined], "old-complete", ["new", "typed"]]);
  });

  it("revokes every pending reply on unregister or destruction without publishing into a replacement", async () => {
    const native = deferredTransition();
    const publish = vi.fn();
    const failure = vi.fn();
    const delivery = createNavigationDelivery(failure);
    delivery.committed({
      read: () => native.promise,
      canPublish: () => true,
      isCurrent: () => true,
      publish,
    });
    delivery.dispatch(publish);
    delivery.invalidate();
    native.resolve("reload");
    await flushNavigation();
    expect(publish).not.toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
  });

  it("keeps a failed native query metadata-less and releases completion without unloading anything", async () => {
    const native = deferredTransition();
    const events: unknown[] = [];
    const failure = vi.fn();
    const delivery = createNavigationDelivery(failure);
    delivery.committed({
      read: () => native.promise,
      canPublish: () => true,
      isCurrent: () => true,
      publish: (type) => events.push(type),
    });
    delivery.dispatch(() => events.push("complete"));
    native.reject(new Error("query detached"));
    await flushNavigation();
    expect(events).toEqual([undefined, "complete"]);
    expect(failure).toHaveBeenCalledTimes(1);
  });
  it("rejects an expired wall clock even before the timeout callback receives an event-loop turn", async () => {
    vi.useFakeTimers();
    try {
      const native = deferredTransition();
      const events: unknown[] = [];
      const failure = vi.fn();
      const delivery = createNavigationDelivery(failure);
      delivery.committed({
        read: () => native.promise,
        canPublish: () => true,
        isCurrent: () => true,
        publish: (type) => events.push(type),
      });
      delivery.dispatch(() => events.push("complete"));
      vi.setSystemTime(Date.now() + 1_001);
      native.resolve("reload");
      await flushNavigation();
      expect(events).toEqual([undefined, "complete"]);
      expect(failure).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
