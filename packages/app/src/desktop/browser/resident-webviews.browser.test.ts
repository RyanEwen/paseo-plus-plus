import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getOverlayRoot } from "@/lib/overlay-root";
import {
  hasWebOverlayPresentationGuard,
  requestWebOverlayPresentation,
} from "@/lib/overlay-presentation";
import {
  applyInactiveBrowserWebviewViewport,
  BROWSER_PRESENTATION_CHANGED_EVENT,
  getBrowserWebviewPresentationScale,
  getBrowserWebviewZoom,
  setBrowserWebviewZoom,
  type BrowserWebviewProfileHost,
  clearResidentBrowserWebviewsForTests,
  ensureResidentBrowserWebview,
  getResidentBrowserWebview,
  prepareBrowserWebview,
  presentBrowserWebview,
  rememberBrowserWebviewSize,
  releaseResidentBrowserWebview,
  removeResidentBrowserWebview,
  resizeResidentBrowserWebview,
  takeResidentBrowserWebview,
} from "./resident-webviews";
import {
  setCommandCenterFocusRestoreElement,
  takeCommandCenterFocusRestoreElement,
} from "../../utils/command-center-focus-restore";

let hostZoom = 1;
const originalHost = window.paseoDesktop;
const originalZoomDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "getZoomFactor",
);

const RESIDENT_HOST_ID = "paseo-browser-resident-webviews";
const attachedBrowsers: Array<{
  browserId: string;
  workspaceId: string;
  webContentsId: number;
}> = [];
const profileHost: BrowserWebviewProfileHost = {
  profilePartition: "persist:paseo-browser",
  registerAttachedBrowser: async (input) => {
    attachedBrowsers.push(input);
  },
};

function ensureTestBrowser(input: {
  browserId: string;
  workspaceId: string;
  url: string;
}): HTMLElement | null {
  return ensureResidentBrowserWebview({ ...input, profileHost });
}

function prepareTestBrowser(
  webview: HTMLElement,
  input: { browserId: string; workspaceId: string; initialUrl?: string | null },
): void {
  prepareBrowserWebview(webview, { ...input, profileHost });
}

function residentHost(): HTMLElement {
  const host = document.getElementById(RESIDENT_HOST_ID);
  if (!host) {
    throw new Error("Expected resident browser host");
  }
  return host;
}

function expectPermanentHostParking(host: HTMLElement): void {
  expect(host.style.position).toBe("fixed");
  expect(host.style.left).toBe("0px");
  expect(host.style.top).toBe("0px");
  expect(host.style.width).toBe("100vw");
  expect(host.style.height).toBe("100vh");
  expect(host.style.overflow).toBe("visible");
  expect(host.style.opacity).toBe("1");
  expect(host.style.pointerEvents).toBe("none");
  expect(host.style.display).toBe("block");
  expect(host.style.zIndex).toBe("0");
}

function expectParkedSurface(surface: HTMLElement): void {
  expect(surface.getAttribute("aria-hidden")).toBe("true");
  expect(surface.style.position).toBe("fixed");
  expect(surface.style.left).toBe("0px");
  expect(surface.style.top).toBe("0px");
  expect(surface.style.width).toBe("1px");
  expect(surface.style.height).toBe("1px");
  expect(surface.style.overflow).toBe("hidden");
  expect(surface.style.opacity).toBe("1");
  expect(surface.style.pointerEvents).toBe("none");
  expect(surface.style.display).toBe("block");
  expect(surface.style.visibility).toBe("visible");
  expect(surface.style.transform).toBe("");
}

function expectResidentWebviewParking(webview: HTMLElement): void {
  expect(webview.style.display).toBe("inline-flex");
  expect(webview.style.flex).toBe("0 0 auto");
  expect(webview.style.width).toBe("1280px");
  expect(webview.style.height).toBe("800px");
  expect(webview.style.position).toBe("absolute");
  expect(webview.style.left).toBe("0px");
  expect(webview.style.top).toBe("0px");
  expect(webview.style.zIndex).toBe("0");
}

describe("resident browser webviews", () => {
  beforeEach(() => {
    attachedBrowsers.length = 0;
    hostZoom = 1;
    window.paseoDesktop = {
      window: { getCurrentWindow: () => ({ getZoomFactor: () => hostZoom }) },
    };
    Object.defineProperty(HTMLElement.prototype, "getZoomFactor", {
      configurable: true,
      value: () => 1,
    });
  });

  afterEach(() => {
    clearResidentBrowserWebviewsForTests();
    window.paseoDesktop = originalHost;
    if (originalZoomDescriptor)
      Object.defineProperty(HTMLElement.prototype, "getZoomFactor", originalZoomDescriptor);
    else
      delete (HTMLElement.prototype as HTMLElement & { getZoomFactor?: () => number })
        .getZoomFactor;
  });

  it("parks a browser webview in the permanent paintable 1x1 host", () => {
    const visibleHost = document.createElement("div");
    const webview = document.createElement("webview");
    visibleHost.appendChild(webview);
    document.body.appendChild(visibleHost);

    releaseResidentBrowserWebview("browser-a", webview);

    const host = residentHost();
    expect(visibleHost.children).toHaveLength(0);
    const surface = host.firstElementChild as HTMLElement;
    expect(Array.from(surface.children)).toEqual([webview]);
    expect(webview.isConnected).toBe(true);
    expectPermanentHostParking(host);
    expectParkedSurface(surface);
    expectResidentWebviewParking(webview);
  });

  it("presents and parks a browser without changing its webview parent", () => {
    const webview = ensureTestBrowser({
      browserId: "browser-stable-parent",
      workspaceId: "workspace-stable-parent",
      url: "https://example.com",
    });
    const anchor = document.createElement("div");
    const clip = document.createElement("div");
    Object.defineProperty(anchor, "getBoundingClientRect", {
      value: () => ({ left: 40, top: 60, width: 640, height: 480 }),
    });
    Object.defineProperty(clip, "getBoundingClientRect", {
      value: () => ({ left: 40, top: 60, width: 640, height: 480 }),
    });
    if (!webview?.parentElement) {
      throw new Error("Expected resident browser surface");
    }
    const permanentParent = webview.parentElement;

    presentBrowserWebview("browser-stable-parent", webview, anchor, clip, {
      mode: "responsive",
    });
    expect(webview.parentElement).toBe(permanentParent);
    expect(permanentParent.style.left).toBe("40px");
    expect(permanentParent.style.top).toBe("60px");
    expect(permanentParent.style.width).toBe("640px");
    expect(permanentParent.style.height).toBe("480px");
    expect(permanentParent.style.pointerEvents).toBe("auto");
    expect(permanentParent.getAttribute("aria-hidden")).toBe("false");
    expect(webview.style.flex).toBe("0 0 auto");
    expect(webview.style.width).toBe("640px");
    expect(webview.style.height).toBe("480px");

    releaseResidentBrowserWebview("browser-stable-parent", webview);
    expect(webview.parentElement).toBe(permanentParent);
    expectParkedSurface(permanentParent);

    presentBrowserWebview("browser-stable-parent", webview, anchor, clip, {
      mode: "responsive",
    });
    expect(webview.parentElement).toBe(permanentParent);
  });

  it("clips an oversized fixed viewport to its pane without resizing the webview", () => {
    const webview = ensureTestBrowser({
      browserId: "browser-oversized",
      workspaceId: "workspace-oversized",
      url: "https://example.com",
    });
    if (!webview?.parentElement) {
      throw new Error("Expected resident browser surface");
    }
    const anchor = document.createElement("div");
    const clip = document.createElement("div");
    Object.defineProperty(anchor, "getBoundingClientRect", {
      value: () => ({ left: -800, top: -300, width: 2560, height: 1440 }),
    });
    Object.defineProperty(clip, "getBoundingClientRect", {
      value: () => ({ left: 100, top: 150, width: 800, height: 600 }),
    });

    presentBrowserWebview("browser-oversized", webview, anchor, clip, {
      mode: "fixed",
      width: 2560,
      height: 1440,
    });

    expect(webview.parentElement.style.left).toBe("100px");
    expect(webview.parentElement.style.top).toBe("150px");
    expect(webview.parentElement.style.width).toBe("800px");
    expect(webview.parentElement.style.height).toBe("600px");
    expect(webview.style.left).toBe("-900px");
    expect(webview.style.top).toBe("-450px");
    expect(webview.style.width).toBe("2560px");
    expect(webview.style.height).toBe("1440px");

    resizeResidentBrowserWebview({ browserId: "browser-oversized", width: 2560, height: 1440 });

    expect(webview.style.left).toBe("-900px");
    expect(webview.style.top).toBe("-450px");
    expect(webview.parentElement.style.width).toBe("800px");
    expect(webview.parentElement.style.height).toBe("600px");
  });

  it("creates a resident webview for an agent-created unfocused tab", () => {
    const webview = ensureTestBrowser({
      browserId: "browser-agent",
      workspaceId: "workspace-agent",
      url: "https://example.com",
    });

    expect(webview).not.toBeNull();
    expect(webview?.isConnected).toBe(true);
    expect(webview?.getAttribute("data-paseo-browser-id")).toBe("browser-agent");
    expect(webview?.getAttribute("partition")).toBe("persist:paseo-browser");
    expect((webview as HTMLUnknownElement & { src?: string })?.src).toContain(
      "https://example.com",
    );
    expectPermanentHostParking(residentHost());
    expectResidentWebviewParking(webview as HTMLElement);
  });

  it("shares one profile and registers guests only when their contents identity is ready", () => {
    const firstWebview = ensureTestBrowser({
      browserId: "browser-first",
      workspaceId: "workspace-a",
      url: "https://example.com/first",
    });
    const secondWebview = ensureTestBrowser({
      browserId: "browser-second",
      workspaceId: "workspace-b",
      url: "https://example.com/second",
    });
    if (!firstWebview || !secondWebview) {
      throw new Error("Expected resident webviews");
    }
    Object.assign(firstWebview, {
      getWebContentsId: () => {
        throw new Error("Guest not ready");
      },
    });
    firstWebview.dispatchEvent(new Event("did-attach"));
    expect(attachedBrowsers).toEqual([]);
    Object.assign(firstWebview, { getWebContentsId: () => 101 });
    Object.assign(secondWebview, { getWebContentsId: () => 202 });

    firstWebview.dispatchEvent(new Event("dom-ready"));
    secondWebview.dispatchEvent(new Event("dom-ready"));

    expect(firstWebview.getAttribute("partition")).toBe("persist:paseo-browser");
    expect(secondWebview.getAttribute("partition")).toBe("persist:paseo-browser");
    expect(attachedBrowsers).toEqual([
      { browserId: "browser-first", workspaceId: "workspace-a", webContentsId: 101 },
      { browserId: "browser-second", workspaceId: "workspace-b", webContentsId: 202 },
    ]);
  });

  it("registers replacement contents on the same resident element", () => {
    const webview = ensureTestBrowser({
      browserId: "browser-replacement",
      workspaceId: "workspace-a",
      url: "https://example.com",
    });
    if (!webview) throw new Error("Expected resident webview");
    Object.assign(webview, { getWebContentsId: () => 101 });
    webview.dispatchEvent(new Event("dom-ready"));
    Object.assign(webview, { getWebContentsId: () => 202 });
    webview.dispatchEvent(new Event("dom-ready"));
    expect(attachedBrowsers).toEqual([
      { browserId: "browser-replacement", workspaceId: "workspace-a", webContentsId: 101 },
      { browserId: "browser-replacement", workspaceId: "workspace-a", webContentsId: 202 },
    ]);
    expect(getResidentBrowserWebview("browser-replacement")).toBe(webview);
  });

  it("keeps the presented guest live beneath the DOM overlay plane without a native suppression lease", () => {
    const webview = ensureTestBrowser({
      browserId: "browser-overlay",
      workspaceId: "workspace-a",
      url: "https://example.com",
    });
    if (!webview?.parentElement) throw new Error("Expected resident browser surface");
    const anchor = document.createElement("div");
    Object.defineProperty(anchor, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 640, height: 480 }),
    });
    presentBrowserWebview("browser-overlay", webview, anchor, anchor, { mode: "responsive" });
    const surface = webview.parentElement;
    const before = surface.style.cssText;
    const overlay = getOverlayRoot();
    expect(Number(overlay.style.zIndex)).toBeGreaterThan(Number(residentHost().style.zIndex));
    expect(hasWebOverlayPresentationGuard()).toBe(false);
    expect(requestWebOverlayPresentation(overlay)).toBeNull();
    expect(surface.style.cssText).toBe(before);
    expect(surface.style.visibility).toBe("visible");
    expect(webview.isConnected).toBe(true);
    expect(getResidentBrowserWebview("browser-overlay")).toBe(webview);
    overlay.remove();
  });

  it.each([
    [0.8, 1],
    [0.8, 1.25],
    [0.8, 2],
    [1, 1],
    [1, 1.25],
    [1, 2],
    [1.5, 1],
    [1.5, 1.25],
    [1.5, 2],
  ])(
    "preserves fixed page CSS dimensions at page zoom %s and host zoom %s across present/park/resize",
    (pageZoom, nextHostZoom) => {
      hostZoom = nextHostZoom;
      const webview = ensureTestBrowser({
        browserId: "browser-zoom",
        workspaceId: "workspace-a",
        url: "https://example.com",
      });
      if (!webview?.parentElement) throw new Error("Expected resident webview");
      Object.defineProperty(webview, "getZoomFactor", {
        configurable: true,
        value: () => pageZoom,
      });
      const anchor = document.createElement("div");
      const clip = document.createElement("div");
      const scale = pageZoom / hostZoom;
      Object.defineProperty(anchor, "getBoundingClientRect", {
        value: () => ({ left: -30, top: -20, width: 1024 * scale, height: 768 * scale }),
      });
      Object.defineProperty(clip, "getBoundingClientRect", {
        value: () => ({ left: 0, top: 0, width: 200, height: 150 }),
      });
      presentBrowserWebview("browser-zoom", webview, anchor, clip, {
        mode: "fixed",
        width: 1024,
        height: 768,
      });
      expect((parseFloat(webview.style.width) * hostZoom) / pageZoom).toBeCloseTo(1024, 2);
      expect((parseFloat(webview.style.height) * hostZoom) / pageZoom).toBeCloseTo(768, 2);
      expect(webview.parentElement.style.width).toBe("200px");
      expect(webview.style.left).toBe("-30px");
      releaseResidentBrowserWebview("browser-zoom", webview);
      expect((parseFloat(webview.style.width) * hostZoom) / pageZoom).toBeCloseTo(1024, 2);
      expect(
        resizeResidentBrowserWebview({ browserId: "browser-zoom", width: 800, height: 600 }),
      ).toEqual({ width: 800, height: 600 });
      releaseResidentBrowserWebview("browser-zoom", webview);
      resizeResidentBrowserWebview({ browserId: "browser-zoom", width: 800, height: 600 });
      expect((parseFloat(webview.style.width) * hostZoom) / pageZoom).toBeCloseTo(800, 2);
      expect((parseFloat(webview.style.height) * hostZoom) / pageZoom).toBeCloseTo(600, 2);
    },
  );

  it("changes only the selected guest and preserves fixed page-CSS sizing while parked and presented", () => {
    hostZoom = 1.25;
    const guest = ensureTestBrowser({
      browserId: "zoom-selected",
      workspaceId: "workspace",
      url: "https://example.com",
    });
    const other = ensureTestBrowser({
      browserId: "zoom-other",
      workspaceId: "workspace",
      url: "https://other.example.com",
    });
    if (!guest || !other) throw new Error("Expected resident guests");
    let factor = 1;
    Object.defineProperties(guest, {
      getZoomFactor: { value: () => factor },
      setZoomFactor: {
        value: (next: number) => {
          factor = next;
        },
      },
    });
    rememberBrowserWebviewSize({
      browserId: "zoom-selected",
      width: 1024,
      height: 768,
      mode: "fixed",
    });
    expect(setBrowserWebviewZoom("zoom-selected", 1.5)).toBe(true);
    expect(getBrowserWebviewZoom(guest)).toBe(1.5);
    expect(getBrowserWebviewZoom(other)).toBe(1);
    expect(hostZoom).toBe(1.25);
    expect(parseFloat(guest.style.width)).toBeCloseTo((1024 * 1.5) / 1.25);
    const anchor = document.createElement("div");
    const clip = document.createElement("div");
    document.body.append(anchor, clip);
    presentBrowserWebview("zoom-selected", guest, anchor, clip, {
      mode: "fixed",
      width: 1024,
      height: 768,
    });
    expect(setBrowserWebviewZoom("zoom-selected", 0.75)).toBe(true);
    expect(parseFloat(guest.style.width)).toBeCloseTo((1024 * 0.75) / 1.25);
    releaseResidentBrowserWebview("zoom-selected", guest);
    expect(setBrowserWebviewZoom("zoom-selected", 1)).toBe(true);
    expect(parseFloat(guest.style.width)).toBeCloseTo(1024 / 1.25);
    anchor.remove();
    clip.remove();
  });

  it("rejects missing, unready and invalid guest zoom changes without calling the setter", () => {
    const guest = ensureTestBrowser({
      browserId: "zoom-unready",
      workspaceId: "workspace",
      url: "https://example.com",
    });
    if (!guest) throw new Error("Expected resident guest");
    let calls = 0;
    Object.defineProperties(guest, {
      getZoomFactor: {
        value: () => {
          throw new Error("not attached");
        },
      },
      setZoomFactor: {
        value: () => {
          calls++;
        },
      },
    });
    expect(getBrowserWebviewZoom(guest)).toBeNull();
    expect(getBrowserWebviewZoom(null)).toBeNull();
    expect(setBrowserWebviewZoom("missing", 1)).toBe(false);
    for (const value of [0, -1, Infinity, NaN, 0.1, 6, 1]) {
      expect(setBrowserWebviewZoom("zoom-unready", value)).toBe(false);
    }
    expect(calls).toBe(0);
  });

  it("refreshes parked zoom from native factors once per ratio change and leaves responsive dimensions in host CSS", () => {
    const webview = ensureTestBrowser({
      browserId: "browser-refresh",
      workspaceId: "workspace-a",
      url: "https://example.com",
    });
    if (!webview) throw new Error("Expected resident webview");
    let pageZoom = 1.5;
    Object.defineProperty(webview, "getZoomFactor", { value: () => pageZoom });
    let changes = 0;
    webview.addEventListener(BROWSER_PRESENTATION_CHANGED_EVENT, () => {
      changes += 1;
    });
    const notify = () =>
      webview.dispatchEvent(
        Object.assign(new Event("ipc-message"), {
          channel: "paseo:browser-viewport-resized",
          args: [999],
        }),
      );
    resizeResidentBrowserWebview({ browserId: "browser-refresh", width: 800, height: 600 });
    notify();
    notify();
    expect(changes).toBe(1);
    expect(webview.style.width).toBe("1200px");
    pageZoom = 2;
    notify();
    expect(changes).toBe(2);
    hostZoom = 1.25;
    window.dispatchEvent(new Event("resize"));
    expect(changes).toBe(3);
    expect(webview.style.width).toBe("1280px");
    const anchor = document.createElement("div");
    Object.defineProperty(anchor, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 640, height: 480 }),
    });
    presentBrowserWebview("browser-refresh", webview, anchor, anchor, { mode: "responsive" });
    expect(webview.style.width).toBe("640px");
    releaseResidentBrowserWebview("browser-refresh", webview);
    notify();
    expect(webview.style.width).toBe("640px");
    expect(changes).toBe(3);
    removeResidentBrowserWebview("browser-refresh");
    pageZoom = 1;
    notify();
    window.dispatchEvent(new Event("resize"));
    expect(changes).toBe(3);
  });

  it.each([0, -1, NaN, Infinity])(
    "does not adopt invalid zoom factor %s or resize an unready guest",
    (invalidZoom) => {
      const webview = ensureTestBrowser({
        browserId: "browser-unready",
        workspaceId: "workspace-a",
        url: "https://example.com",
      });
      if (!webview) throw new Error("Expected resident webview");
      const before = webview.style.width;
      hostZoom = invalidZoom;
      expect(getBrowserWebviewPresentationScale(webview)).toBeNull();
      applyInactiveBrowserWebviewViewport("browser-unready", webview, {
        mode: "fixed",
        width: 800,
        height: 600,
      });
      expect(webview.style.width).toBe(before);
      hostZoom = 1;
      Object.defineProperty(webview, "getZoomFactor", {
        configurable: true,
        value: () => invalidZoom,
      });
      expect(getBrowserWebviewPresentationScale(webview)).toBeNull();
      Object.defineProperty(webview, "getZoomFactor", {
        value: () => {
          throw new Error("Not attached");
        },
      });
      expect(getBrowserWebviewPresentationScale(webview)).toBeNull();
      releaseResidentBrowserWebview("browser-unready", webview);
      expect(webview.style.width).toBe(before);
    },
  );

  it("normalizes an existing resident host back to permanent parking", () => {
    const staleHost = document.createElement("div");
    staleHost.id = RESIDENT_HOST_ID;
    staleHost.style.left = "-20000px";
    staleHost.style.width = "1280px";
    staleHost.style.height = "800px";
    staleHost.style.opacity = "0";
    staleHost.style.display = "none";
    document.body.appendChild(staleHost);

    const webview = ensureTestBrowser({
      browserId: "browser-stale-host",
      workspaceId: "workspace-stale-host",
      url: "https://example.com",
    });

    expect(webview).not.toBeNull();
    expectPermanentHostParking(staleHost);
    expectResidentWebviewParking(webview as HTMLElement);
  });

  it("normalizes an existing resident webview and its stale host before reusing them", () => {
    const staleHost = document.createElement("div");
    staleHost.id = RESIDENT_HOST_ID;
    staleHost.style.left = "-20000px";
    staleHost.style.width = "1280px";
    staleHost.style.height = "800px";
    staleHost.style.opacity = "0";
    staleHost.style.display = "none";

    const staleWebview = document.createElement("webview");
    prepareTestBrowser(staleWebview, {
      browserId: "browser-stale-child",
      workspaceId: "workspace-stale-child",
      initialUrl: "https://example.com",
    });
    staleWebview.style.display = "none";
    staleWebview.style.width = "1px";
    staleWebview.style.height = "1px";
    staleWebview.style.position = "fixed";
    staleWebview.style.left = "-20000px";
    staleHost.appendChild(staleWebview);
    document.body.appendChild(staleHost);

    const webview = ensureTestBrowser({
      browserId: "browser-stale-child",
      workspaceId: "workspace-stale-child",
      url: "https://example.com/agent",
    });

    expect(webview).toBe(staleWebview);
    const surface = staleHost.firstElementChild as HTMLElement;
    expect(Array.from(surface.children)).toEqual([staleWebview]);
    expectPermanentHostParking(staleHost);
    expectParkedSurface(surface);
    expectResidentWebviewParking(staleWebview);
  });

  it("parks resident webviews as an overlapping stack", () => {
    const firstWebview = ensureTestBrowser({
      browserId: "browser-first",
      workspaceId: "workspace-stack",
      url: "https://example.com/first",
    });
    const secondWebview = ensureTestBrowser({
      browserId: "browser-second",
      workspaceId: "workspace-stack",
      url: "https://example.com/second",
    });

    const host = residentHost();
    expect(firstWebview?.parentElement?.parentElement).toBe(host);
    expect(secondWebview?.parentElement?.parentElement).toBe(host);
    expect(firstWebview?.parentElement).not.toBe(secondWebview?.parentElement);
    expectResidentWebviewParking(firstWebview as HTMLElement);
    expectResidentWebviewParking(secondWebview as HTMLElement);
  });

  it("returns a resident webview without detaching it from its permanent surface", () => {
    const webview = ensureTestBrowser({
      browserId: "browser-visible",
      workspaceId: "workspace-visible",
      url: "https://example.com",
    });

    const permanentParent = webview?.parentElement;
    const visibleWebview = takeResidentBrowserWebview("browser-visible");

    expect(visibleWebview).toBe(webview);
    expect(webview?.parentElement).toBe(permanentParent);
    expect(takeResidentBrowserWebview("browser-visible")).toBe(webview);
  });

  it("applies an exact fixed viewport without a flex width override", () => {
    const webview = document.createElement("webview");
    const anchor = document.createElement("div");
    const clip = document.createElement("div");
    Object.defineProperty(anchor, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 640, height: 480 }),
    });
    Object.defineProperty(clip, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 640, height: 480 }),
    });

    presentBrowserWebview("browser-fixed", webview, anchor, clip, {
      mode: "fixed",
      width: 640,
      height: 480,
    });

    expect(webview.style.flex).toBe("0 0 auto");
    expect(webview.style.width).toBe("640px");
    expect(webview.style.height).toBe("480px");
  });

  it("parks a browser at its last resolved viewport dimensions", () => {
    const visibleHost = document.createElement("div");
    const webview = document.createElement("webview");
    visibleHost.appendChild(webview);
    document.body.appendChild(visibleHost);
    rememberBrowserWebviewSize({ browserId: "browser-sized", width: 640, height: 480 });

    releaseResidentBrowserWebview("browser-sized", webview);

    expect(webview.style.width).toBe("640px");
    expect(webview.style.height).toBe("480px");
  });

  it("keeps an inactive in-place browser at its last resolved viewport dimensions", () => {
    const webview = document.createElement("webview");
    rememberBrowserWebviewSize({ browserId: "browser-inactive", width: 640, height: 480 });

    applyInactiveBrowserWebviewViewport("browser-inactive", webview, { mode: "responsive" });

    expect(webview.style.flex).toBe("0 0 auto");
    expect(webview.style.width).toBe("640px");
    expect(webview.style.height).toBe("480px");
  });

  it("parks a cold inactive browser at its canonical fixed viewport", () => {
    const webview = document.createElement("webview");

    applyInactiveBrowserWebviewViewport("browser-restored-fixed", webview, {
      mode: "fixed",
      width: 800,
      height: 600,
    });

    expect(webview.style.width).toBe("800px");
    expect(webview.style.height).toBe("600px");
  });

  it("returns an existing visible pane webview instead of creating a resident duplicate", () => {
    const visibleHost = document.createElement("div");
    const visibleWebview = document.createElement("webview");
    prepareTestBrowser(visibleWebview, {
      browserId: "browser-visible-pane",
      workspaceId: "workspace-visible-pane",
      initialUrl: "https://example.com",
    });
    visibleHost.appendChild(visibleWebview);
    document.body.appendChild(visibleHost);

    const webview = ensureTestBrowser({
      browserId: "browser-visible-pane",
      workspaceId: "workspace-visible-pane",
      url: "https://example.com/agent",
    });

    expect(webview).toBe(visibleWebview);
    expect(document.getElementById(RESIDENT_HOST_ID)).toBeNull();
  });

  it("finds the originating browser webview for focus restoration", () => {
    const webview = ensureTestBrowser({
      browserId: "browser-focus",
      workspaceId: "workspace-focus",
      url: "https://example.com",
    });

    setCommandCenterFocusRestoreElement(getResidentBrowserWebview("browser-focus"));

    expect(takeCommandCenterFocusRestoreElement()).toBe(webview);

    expect(getResidentBrowserWebview("browser-missing")).toBeNull();
  });

  it("removes a resident webview when its browser tab closes", () => {
    const webview = ensureTestBrowser({
      browserId: "browser-closed",
      workspaceId: "workspace-closed",
      url: "https://example.com",
    });

    removeResidentBrowserWebview("browser-closed");

    expect(webview?.isConnected).toBe(false);
    expect(takeResidentBrowserWebview("browser-closed")).toBeNull();
  });
});
