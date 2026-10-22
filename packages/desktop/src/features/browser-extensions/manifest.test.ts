import { createExtensionActionBadges } from "./action-badges.js";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getExtensionPopupUrl,
  getExtensionToolbarMetadata,
  readExtensionToolbarIcon,
} from "./manifest.js";

const id = "abcdefghijklmnopabcdefghijklmnop";

describe("extension toolbar popup", () => {
  it.each(["action", "browser_action", "page_action"])("resolves %s packaged popup", (kind) => {
    expect(getExtensionPopupUrl(id, { [kind]: { default_popup: "popup/index.html" } })).toBe(
      `chrome-extension://${id}/popup/index.html`,
    );
  });

  it.each([
    "https://example.com/",
    "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
    "//example.com/a",
    "http://[invalid",
  ])("rejects popup outside the extension: %s", (default_popup) => {
    expect(getExtensionPopupUrl(id, { action: { default_popup } })).toBeNull();
  });

  it("does not invent a popup for background-only extensions", () => {
    expect(getExtensionPopupUrl(id, { action: {} })).toBeNull();
    expect(getExtensionPopupUrl(id, {})).toBeNull();
  });
});

describe("extension toolbar metadata", () => {
  it("uses the action title/icon, selects a suitable raster size and falls back to manifest icons", () => {
    expect(
      getExtensionToolbarMetadata(
        {
          action: {
            default_title: "Open fixture",
            default_icon: { 16: "small.png", 32: "toolbar.png", 128: "large.png" },
          },
        },
        "Fixture",
      ),
    ).toEqual({ title: "Open fixture", iconPath: "toolbar.png" });
    expect(
      getExtensionToolbarMetadata(
        { browser_action: { default_title: "__MSG_title__" }, icons: { 16: "icon.png" } },
        "Localized name",
      ),
    ).toEqual({ title: "Localized name", iconPath: "icon.png" });
    expect(
      getExtensionToolbarMetadata({ action: { default_icon: "icon.png" } }, "Fixture"),
    ).toEqual({ title: "Fixture", iconPath: "icon.png" });
    expect(
      getExtensionPopupUrl(id, { action: { default_popup: "popup.html", default_icon: 42 } }),
    ).toBe(`chrome-extension://${id}/popup.html`);
  });
});

const iconDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    iconDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
it("reads only bounded real icon files inside the extension package", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "paseo-extension-icon-"));
  iconDirectories.push(directory);
  const extension = path.join(directory, "extension");
  await mkdir(extension);
  await writeFile(path.join(extension, "icon.png"), "packaged icon");
  await writeFile(path.join(directory, "outside.png"), "outside");
  await symlink(path.join(directory, "outside.png"), path.join(extension, "linked.png"));
  await writeFile(path.join(extension, "oversized.png"), Buffer.alloc(1024 * 1024 + 1));
  expect((await readExtensionToolbarIcon(extension, "/icon.png"))?.toString()).toBe(
    "packaged icon",
  );
  expect(await readExtensionToolbarIcon(extension, "linked.png")).toBeNull();
  expect(await readExtensionToolbarIcon(extension, "oversized.png")).toBeNull();
  expect(await readExtensionToolbarIcon(extension, "https://example.com/icon.png")).toBeNull();
  expect(await readExtensionToolbarIcon(extension, "../outside.png")).toBeNull();
  expect(await readExtensionToolbarIcon(extension, "missing.png")).toBeNull();
});

// Badge behavior belongs to the existing toolbar metadata contract, independent of popup support.
describe("extension toolbar badges", () => {
  it("inherits each property, distinguishes hidden text from null reset, and clears tab state", async () => {
    const changed = vi.fn();
    const badges = createExtensionActionBadges({ hasTab: (tabId) => tabId === 12, changed });
    badges.request("a", "action.setBadgeText", { text: "global" });
    badges.request("a", "action.setBadgeBackgroundColor", { color: [10, 20, 30, 255] });
    badges.request("a", "action.setBadgeText", { tabId: 12, text: "" });
    expect(badges.snapshot("a", 12)).toEqual({
      text: "",
      backgroundColor: [10, 20, 30, 255],
      textColor: null,
    });
    badges.request("a", "browserAction.setBadgeText", { tabId: 12, text: "tab" });
    badges.request("a", "action.setBadgeBackgroundColor", { color: [40, 50, 60, 255] });
    expect(badges.request("a", "action.getBadgeBackgroundColor", { tabId: 12 })).toEqual([
      40, 50, 60, 255,
    ]);
    badges.request("a", "action.setBadgeTextColor", { tabId: 12, color: [255, 255, 255, 255] });
    badges.request("a", "action.setBadgeText", { tabId: 12, text: null });
    expect(badges.request("a", "action.getBadgeText", { tabId: 12 })).toBe("global");
    expect(badges.request("a", "action.getBadgeTextColor", { tabId: 12 })).toEqual([
      255, 255, 255, 255,
    ]);
    expect(badges.request("a", "action.getBadgeTextColor", {})).toEqual([0, 0, 0, 0]);
    badges.forgetTab(12);
    expect(badges.snapshot("a", 12).textColor).toBeNull();
    await Promise.resolve();
    expect(changed).toHaveBeenCalledTimes(1);
    badges.forgetExtension("a");
    expect(badges.snapshot("a", 12).text).toBe("");
  });

  it("rejects malformed/foreign tabs and colors without crossing extension or profile boundaries", () => {
    const a = createExtensionActionBadges({ hasTab: (tabId) => tabId === 1, changed: () => {} });
    const b = createExtensionActionBadges({ hasTab: (tabId) => tabId === 2, changed: () => {} });
    a.request("a", "action.setBadgeText", { text: "private to A" });
    expect(a.snapshot("b").text).toBe("");
    expect(b.snapshot("a").text).toBe("");
    for (const tabId of [0, 2, -1, 1.5, NaN]) {
      expect(() => a.request("a", "action.setBadgeText", { tabId, text: "wrong" })).toThrow();
    }
    expect(() =>
      a.request("a", "action.setBadgeText", { text: "wrong", extensionId: "b" }),
    ).toThrow();
    for (const color of [[1, 2, 3], [256, 0, 0, 255], [1.5, 0, 0, 255], "url(private)"]) {
      expect(() => a.request("a", "action.setBadgeBackgroundColor", { color })).toThrow();
    }
    expect(() => a.request("a", "action.setBadgeTextColor", { color: [1, 2, 3, 0] })).toThrow();
    expect(a.snapshot("a").text).toBe("private to A");
  });
});
