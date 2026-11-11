import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";
import { buildTerminalLinkMenuInput, runTerminalLinkMenuAction } from "./link-menu";

// Labels are opaque to the menu; echoing the key keeps the assertions readable.
const echoKey = ((key: string) => key) as unknown as TFunction;

describe("terminal link menu input", () => {
  it("describes a hovered web link with all three labels", () => {
    expect(
      buildTerminalLinkMenuInput({
        url: "https://example.com/path?q=1#top",
        hasWorkspaceBrowser: true,
        t: echoKey,
      }),
    ).toEqual({
      url: "https://example.com/path?q=1#top",
      openInPaseo: true,
      labels: {
        internal: "workspace.browser.openInPaseo",
        external: "workspace.browser.openExternally",
        copy: "workspace.browser.copyLink",
      },
    });
  });

  it("marks the Paseo destination unavailable without a workspace browser", () => {
    expect(
      buildTerminalLinkMenuInput({
        url: "http://localhost:3000",
        hasWorkspaceBrowser: false,
        t: echoKey,
      })?.openInPaseo,
    ).toBe(false);
  });

  it.each([null, undefined, "", "file:///tmp/readme.md", "mailto:person@example.com"])(
    "adds no link section for %s",
    (url) => {
      expect(buildTerminalLinkMenuInput({ url, hasWorkspaceBrowser: true, t: echoKey })).toBe(
        undefined,
      );
    },
  );
});

describe("terminal link menu action", () => {
  it("opens the link in the workspace browser for the internal choice", async () => {
    const opened: string[] = [];
    await runTerminalLinkMenuAction({
      action: "open-internal",
      url: "https://example.com",
      openInPaseo: (url) => {
        opened.push(url);
      },
    });
    expect(opened).toEqual(["https://example.com"]);
  });

  it("does nothing when the menu closed without a link choice", async () => {
    const opened: string[] = [];
    await runTerminalLinkMenuAction({
      action: null,
      url: "https://example.com",
      openInPaseo: (url) => {
        opened.push(url);
      },
    });
    expect(opened).toEqual([]);
  });
});
