import {
  getDesktopHost,
  type DesktopAttachedBrowserRegistration,
  type DesktopBrowserBridge,
} from "@/desktop/host";
import type { BrowserViewport } from "@/desktop/browser/store";
import { WEB_SURFACE_PLANE } from "@/lib/overlay-root";

export const BROWSER_PRESENTATION_CHANGED_EVENT = "paseo-browser-presentation-changed";

const RESIDENT_BROWSER_HOST_ID = "paseo-browser-resident-webviews";
const BROWSER_ID_ATTRIBUTE = "data-paseo-browser-id";
const BROWSER_SURFACE_ATTRIBUTE = "data-paseo-browser-surface";
const RESIDENT_VIEWPORT_WIDTH = 1280;
const RESIDENT_VIEWPORT_HEIGHT = 800;

const residentWebviewsByBrowserId = new Map<string, HTMLElement>();
const residentSurfacesByBrowserId = new Map<string, HTMLElement>();
interface BrowserDimensions {
  width: number;
  height: number;
  mode: "fixed" | "responsive";
}
const residentWebviewSizesByBrowserId = new Map<string, BrowserDimensions>();
const residentZoomCleanups = new Map<string, () => void>();

/** Read the guest's actual page zoom; attachment and navigation can make it unavailable. */
export function getBrowserWebviewZoom(webview: HTMLElement | null): number | null {
  try {
    const zoom = (
      webview as (HTMLElement & { getZoomFactor?: () => number }) | null
    )?.getZoomFactor?.();
    return typeof zoom === "number" && Number.isFinite(zoom) && zoom > 0 ? zoom : null;
  } catch {
    return null;
  }
}

/** Set native page zoom through the retained guest and refresh its fixed page-CSS extent.
 * Chromium can share this zoom with other guests from the same origin.
 */
export function setBrowserWebviewZoom(browserId: string, factor: number): boolean {
  const webview = residentWebviewsByBrowserId.get(browserId);
  if (!webview || !Number.isFinite(factor) || factor < 0.25 || factor > 5) return false;
  const guest = webview as HTMLElement & { setZoomFactor?: (factor: number) => void };
  if (!guest.setZoomFactor || getBrowserWebviewZoom(webview) === null) return false;
  try {
    guest.setZoomFactor(factor);
    applyBrowserWebviewDimensions(webview, dimensionsForBrowser(browserId));
    webview.dispatchEvent(new Event(BROWSER_PRESENTATION_CHANGED_EVENT));
    return true;
  } catch {
    // Navigation or disposal can detach a guest between the readiness read and setter.
    return false;
  }
}

/** Read native factors only; an unattached guest cannot yet supply its zoom. */
export function getBrowserWebviewPresentationScale(webview: HTMLElement): number | null {
  try {
    const pageZoom = (webview as HTMLElement & { getZoomFactor?: () => number }).getZoomFactor?.();
    const hostZoom = getDesktopHost()?.window?.getCurrentWindow?.().getZoomFactor?.();
    if (
      !Number.isFinite(pageZoom) ||
      !Number.isFinite(hostZoom) ||
      !pageZoom ||
      !hostZoom ||
      pageZoom <= 0 ||
      hostZoom <= 0
    )
      return null;
    const ratio = pageZoom / hostZoom;
    return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
  } catch {
    return null;
  }
}

function observeBrowserZoom(webview: HTMLElement, browserId: string): void {
  let previousScale: number | null = null;
  const refresh = () => {
    applyBrowserWebviewDimensions(webview, dimensionsForBrowser(browserId));
    const scale = getBrowserWebviewPresentationScale(webview);
    if (scale !== null && scale !== previousScale) {
      previousScale = scale;
      webview.dispatchEvent(new Event(BROWSER_PRESENTATION_CHANGED_EVENT));
    }
  };
  const handleMessage = (event: Event) => {
    if ((event as Event & { channel?: string }).channel === "paseo:browser-viewport-resized")
      refresh();
  };
  residentZoomCleanups.get(browserId)?.();
  webview.addEventListener("dom-ready", refresh);
  webview.addEventListener("ipc-message", handleMessage);
  window.addEventListener("resize", refresh);
  residentZoomCleanups.set(browserId, () => {
    webview.removeEventListener("dom-ready", refresh);
    webview.removeEventListener("ipc-message", handleMessage);
    window.removeEventListener("resize", refresh);
  });
}

interface BrowserWebviewElement extends HTMLElement {
  src: string;
  getWebContentsId(): number;
}

interface BrowserWebviewIdentity {
  browserId: string;
  workspaceId: string;
}

export interface BrowserWebviewProfileHost {
  profilePartition: string;
  registerAttachedBrowser(input: DesktopAttachedBrowserRegistration): Promise<void>;
}

function isAttachedBrowserBridge(
  browser: DesktopBrowserBridge | undefined,
): browser is BrowserWebviewProfileHost {
  return (
    browser !== undefined &&
    typeof browser.profilePartition === "string" &&
    browser.profilePartition.startsWith("persist:") &&
    typeof browser.registerAttachedBrowser === "function"
  );
}

function getBrowserBridge(override?: BrowserWebviewProfileHost): BrowserWebviewProfileHost {
  if (override) {
    return override;
  }
  const browser = getDesktopHost()?.browser;
  if (!isAttachedBrowserBridge(browser)) {
    throw new Error("Electron browser profile bridge is unavailable");
  }
  return browser;
}

function registerBrowserWhenReady(
  webview: BrowserWebviewElement,
  identity: BrowserWebviewIdentity,
  browser: BrowserWebviewProfileHost,
): void {
  // Extensions can make did-attach fire before getWebContentsId is usable.
  // dom-ready also registers replacement WebContents on the same DOM element.
  webview.addEventListener("dom-ready", () => {
    const webContentsId = webview.getWebContentsId();
    void browser
      .registerAttachedBrowser({
        browserId: identity.browserId,
        workspaceId: identity.workspaceId,
        webContentsId,
      })
      .catch((error) => {
        console.error("[browser-webview] attached registration failed", error);
      });
  });
}

function trimNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readDocument(): Document | null {
  return typeof document === "undefined" ? null : document;
}

function applyResidentHostParkingStyle(host: HTMLElement): void {
  // The host is permanent. Individual browser surfaces switch between their
  // pane bounds and the proven paintable 1x1 parking geometry.
  host.removeAttribute("aria-hidden");
  host.style.position = "fixed";
  host.style.left = "0";
  host.style.top = "0";
  host.style.width = "100vw";
  host.style.height = "100vh";
  host.style.overflow = "visible";
  host.style.opacity = "1";
  host.style.pointerEvents = "none";
  host.style.display = "block";
  host.style.zIndex = String(WEB_SURFACE_PLANE.browser);
  host.style.clipPath = "";
  host.style.visibility = "visible";
  host.style.transform = "";
}

function applyParkedBrowserSurfaceStyle(surface: HTMLElement): void {
  surface.setAttribute("aria-hidden", "true");
  surface.style.position = "fixed";
  surface.style.left = "0";
  surface.style.top = "0";
  surface.style.width = "1px";
  surface.style.height = "1px";
  surface.style.overflow = "hidden";
  surface.style.opacity = "1";
  surface.style.pointerEvents = "none";
  surface.style.display = "block";
  surface.style.visibility = "visible";
  surface.style.transform = "";
}

function getBrowserSurface(browserId: string, ownerDocument: Document): HTMLElement {
  const existing = residentSurfacesByBrowserId.get(browserId);
  if (existing?.isConnected) {
    return existing;
  }
  const surface = ownerDocument.createElement("div");
  surface.setAttribute(BROWSER_SURFACE_ATTRIBUTE, browserId);
  applyParkedBrowserSurfaceStyle(surface);
  getResidentBrowserHost(ownerDocument).appendChild(surface);
  residentSurfacesByBrowserId.set(browserId, surface);
  return surface;
}

function getResidentBrowserHost(ownerDocument: Document): HTMLElement {
  const existing = ownerDocument.getElementById(RESIDENT_BROWSER_HOST_ID);
  if (existing) {
    applyResidentHostParkingStyle(existing);
    return existing;
  }

  const host = ownerDocument.createElement("div");
  host.id = RESIDENT_BROWSER_HOST_ID;
  applyResidentHostParkingStyle(host);
  ownerDocument.body.appendChild(host);
  return host;
}

function findBrowserWebview(browserId: string, ownerDocument: Document): HTMLElement | null {
  for (const element of ownerDocument.querySelectorAll(`[${BROWSER_ID_ATTRIBUTE}]`)) {
    if (!(element instanceof HTMLElement)) {
      continue;
    }
    if (element.getAttribute(BROWSER_ID_ATTRIBUTE) === browserId) {
      return element;
    }
  }
  return null;
}

function dimensionsForBrowser(browserId: string | null): BrowserDimensions {
  if (!browserId) {
    return { width: RESIDENT_VIEWPORT_WIDTH, height: RESIDENT_VIEWPORT_HEIGHT, mode: "fixed" };
  }
  return (
    residentWebviewSizesByBrowserId.get(browserId) ?? {
      width: RESIDENT_VIEWPORT_WIDTH,
      height: RESIDENT_VIEWPORT_HEIGHT,
      mode: "fixed",
    }
  );
}

function applyResidentWebviewStyle(webview: HTMLElement, browserId: string | null): void {
  const dimensions = dimensionsForBrowser(browserId);
  applyBrowserWebviewDimensions(webview, dimensions);
  webview.style.display = "inline-flex";
  webview.style.flex = "0 0 auto";
  webview.style.border = "0";
  webview.style.background = "transparent";
  webview.style.position = "absolute";
  webview.style.left = "0";
  webview.style.top = "0";
  webview.style.marginTop = "0";
  webview.style.zIndex = "0";
}

function clearResidentWebviewParkingStyle(webview: HTMLElement): void {
  webview.style.position = "";
  webview.style.left = "";
  webview.style.top = "";
  webview.style.marginTop = "";
  webview.style.zIndex = "";
}

export function rememberBrowserWebviewSize(input: {
  browserId: string;
  width: number;
  height: number;
  mode?: "fixed" | "responsive";
}): { width: number; height: number } | null {
  const browserId = trimNonEmpty(input.browserId);
  if (
    !browserId ||
    !Number.isFinite(input.width) ||
    !Number.isFinite(input.height) ||
    input.width <= 0 ||
    input.height <= 0
  ) {
    return null;
  }
  const dimensions = {
    width: Math.max(1, Math.round(input.width)),
    height: Math.max(1, Math.round(input.height)),
  };
  residentWebviewSizesByBrowserId.set(browserId, { ...dimensions, mode: input.mode ?? "fixed" });
  return dimensions;
}

function applyBrowserWebviewDimensions(webview: HTMLElement, dimensions: BrowserDimensions): void {
  const scale = dimensions.mode === "fixed" ? getBrowserWebviewPresentationScale(webview) : 1;
  if (scale === null) return;
  webview.style.display = "flex";
  webview.style.border = "0";
  webview.style.background = "transparent";
  webview.style.flex = "0 0 auto";
  webview.style.width = `${Math.max(1, dimensions.width * scale)}px`;
  webview.style.height = `${Math.max(1, dimensions.height * scale)}px`;
}

export function applyInactiveBrowserWebviewViewport(
  browserId: string,
  webview: HTMLElement,
  viewport: BrowserViewport,
): void {
  if (viewport.mode === "fixed") {
    rememberBrowserWebviewSize({ browserId, width: viewport.width, height: viewport.height });
  }
  applyResidentWebviewStyle(webview, trimNonEmpty(browserId));
}

export function presentBrowserWebview(
  browserId: string,
  webview: HTMLElement,
  anchor: HTMLElement,
  clip: HTMLElement,
  viewport: BrowserViewport,
): void {
  const normalizedBrowserId = trimNonEmpty(browserId);
  if (!normalizedBrowserId) {
    return;
  }
  const ownerDocument = readDocument();
  if (!ownerDocument) {
    return;
  }
  const surface = getBrowserSurface(normalizedBrowserId, ownerDocument);
  if (webview.parentElement !== surface) {
    surface.appendChild(webview);
  }
  const anchorBounds = anchor.getBoundingClientRect();
  const clipBounds = clip.getBoundingClientRect();
  const left = Math.max(anchorBounds.left, clipBounds.left);
  const top = Math.max(anchorBounds.top, clipBounds.top);
  const right = Math.min(
    anchorBounds.left + anchorBounds.width,
    clipBounds.left + clipBounds.width,
  );
  const bottom = Math.min(
    anchorBounds.top + anchorBounds.height,
    clipBounds.top + clipBounds.height,
  );
  const surfaceLeft = Math.ceil(left);
  const surfaceTop = Math.ceil(top);
  const surfaceRight = Math.floor(right);
  const surfaceBottom = Math.floor(bottom);
  const hasVisibleArea = surfaceRight > surfaceLeft && surfaceBottom > surfaceTop;
  surface.setAttribute("aria-hidden", "false");
  surface.style.position = "fixed";
  surface.style.left = `${surfaceLeft}px`;
  surface.style.top = `${surfaceTop}px`;
  surface.style.width = `${Math.max(0, surfaceRight - surfaceLeft)}px`;
  surface.style.height = `${Math.max(0, surfaceBottom - surfaceTop)}px`;
  surface.style.overflow = "hidden";
  surface.style.opacity = "1";
  surface.style.pointerEvents = hasVisibleArea ? "auto" : "none";
  surface.style.display = "flex";
  surface.style.visibility = "visible";
  clearResidentWebviewParkingStyle(webview);
  rememberBrowserWebviewSize({
    browserId: normalizedBrowserId,
    ...(viewport.mode === "responsive"
      ? { width: anchorBounds.width, height: anchorBounds.height }
      : viewport),
    mode: viewport.mode,
  });
  applyBrowserWebviewDimensions(webview, dimensionsForBrowser(normalizedBrowserId));
  webview.style.position = "absolute";
  webview.style.left = `${Math.round(anchorBounds.left - surfaceLeft)}px`;
  webview.style.top = `${Math.round(anchorBounds.top - surfaceTop)}px`;
}

export function prepareBrowserWebview(
  webview: HTMLElement,
  input: {
    browserId: string;
    workspaceId: string;
    initialUrl?: string | null;
    profileHost?: BrowserWebviewProfileHost;
  },
): void {
  const browser = getBrowserBridge(input.profileHost);
  webview.setAttribute(BROWSER_ID_ATTRIBUTE, input.browserId);
  webview.setAttribute("partition", browser.profilePartition);
  webview.setAttribute("allowpopups", "true");
  webview.setAttribute("spellcheck", "false");
  webview.setAttribute("autosize", "on");
  if (input.initialUrl) {
    (webview as BrowserWebviewElement).src = input.initialUrl;
  }
  registerBrowserWhenReady(webview as BrowserWebviewElement, input, browser);
  observeBrowserZoom(webview, input.browserId);
}

export function ensureResidentBrowserWebview(input: {
  browserId: string;
  workspaceId: string;
  url: string;
  profileHost?: BrowserWebviewProfileHost;
}): HTMLElement | null {
  const browserId = trimNonEmpty(input.browserId);
  if (!browserId) {
    return null;
  }
  const ownerDocument = readDocument();
  if (!ownerDocument) {
    return null;
  }

  const resident = residentWebviewsByBrowserId.get(browserId) ?? null;
  if (resident?.isConnected) {
    releaseResidentBrowserWebview(browserId, resident);
    return resident;
  }

  const existing = findBrowserWebview(browserId, ownerDocument);
  if (existing) {
    if (existing.parentElement?.id === RESIDENT_BROWSER_HOST_ID) {
      releaseResidentBrowserWebview(browserId, existing);
    }
    return existing;
  }

  const webview = ownerDocument.createElement("webview") as BrowserWebviewElement;
  prepareBrowserWebview(webview, {
    browserId,
    workspaceId: input.workspaceId,
    initialUrl: input.url,
    profileHost: input.profileHost,
  });
  releaseResidentBrowserWebview(browserId, webview);
  return webview;
}

export function getResidentBrowserWebview(browserId: string): HTMLElement | null {
  const normalizedBrowserId = trimNonEmpty(browserId);
  if (!normalizedBrowserId) {
    return null;
  }
  const resident = residentWebviewsByBrowserId.get(normalizedBrowserId) ?? null;
  if (resident?.isConnected) {
    return resident;
  }
  const ownerDocument = readDocument();
  return ownerDocument ? findBrowserWebview(normalizedBrowserId, ownerDocument) : null;
}

export function takeResidentBrowserWebview(browserId: string): HTMLElement | null {
  const normalizedBrowserId = trimNonEmpty(browserId);
  if (!normalizedBrowserId) {
    return null;
  }

  const webview = residentWebviewsByBrowserId.get(normalizedBrowserId) ?? null;
  if (!webview) {
    return null;
  }

  return webview;
}

export function releaseResidentBrowserWebview(browserId: string, webview: HTMLElement): void {
  const normalizedBrowserId = trimNonEmpty(browserId);
  if (!normalizedBrowserId) {
    webview.remove();
    return;
  }
  const ownerDocument = readDocument();
  if (!ownerDocument) {
    return;
  }

  residentWebviewsByBrowserId.set(normalizedBrowserId, webview);
  applyResidentWebviewStyle(webview, normalizedBrowserId);
  const surface = getBrowserSurface(normalizedBrowserId, ownerDocument);
  applyParkedBrowserSurfaceStyle(surface);
  if (webview.parentElement !== surface) {
    surface.appendChild(webview);
  }
}

export function resizeResidentBrowserWebview(input: {
  browserId: string;
  width: number;
  height: number;
}): { width: number; height: number } | null {
  const normalizedBrowserId = trimNonEmpty(input.browserId);
  if (!normalizedBrowserId) {
    return null;
  }
  const dimensions = rememberBrowserWebviewSize(input);
  if (!dimensions) {
    return null;
  }

  const ownerDocument = readDocument();
  const webview = ownerDocument ? findBrowserWebview(normalizedBrowserId, ownerDocument) : null;
  if (webview) {
    applyBrowserWebviewDimensions(webview, { ...dimensions, mode: "fixed" });
  }

  return dimensions;
}

export function removeResidentBrowserWebview(browserId: string): void {
  const normalizedBrowserId = trimNonEmpty(browserId);
  if (!normalizedBrowserId) {
    return;
  }

  const resident = residentWebviewsByBrowserId.get(normalizedBrowserId) ?? null;
  const surface = residentSurfacesByBrowserId.get(normalizedBrowserId) ?? null;
  residentZoomCleanups.get(normalizedBrowserId)?.();
  residentZoomCleanups.delete(normalizedBrowserId);
  residentWebviewsByBrowserId.delete(normalizedBrowserId);
  residentSurfacesByBrowserId.delete(normalizedBrowserId);
  residentWebviewSizesByBrowserId.delete(normalizedBrowserId);
  resident?.remove();
  surface?.remove();
}

export function clearResidentBrowserWebviewsForTests(): void {
  for (const cleanup of residentZoomCleanups.values()) cleanup();
  residentZoomCleanups.clear();
  for (const webview of residentWebviewsByBrowserId.values()) {
    webview.remove();
  }
  residentWebviewsByBrowserId.clear();
  residentSurfacesByBrowserId.clear();
  residentWebviewSizesByBrowserId.clear();
  readDocument()?.getElementById(RESIDENT_BROWSER_HOST_ID)?.remove();
}
