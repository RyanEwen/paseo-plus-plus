import type { ExtensionActionBadge } from "./action-badges.js";
import { BrowserWindow, ipcMain, nativeImage, type Session, type WebContents } from "electron";
import { z } from "zod";
import { getPaseoBrowserWebContentsForHostWindow } from "../browser-webviews/index.js";
import type { BrowserExtensionCatalog } from "./catalog.js";
import {
  getExtensionPopupUrl,
  getExtensionToolbarMetadata,
  readExtensionToolbarIcon,
} from "./manifest.js";
import { openBrowserExtensionDocumentWindow } from "./document-window.js";

const PopupInputSchema = z.object({
  id: z.string().regex(/^[a-p]{32}$/),
  browserId: z.string().min(1),
});

interface ExtensionActionsOptions {
  profile: Session;
  catalog: BrowserExtensionCatalog;
  assertAppSender(event: Electron.IpcMainInvokeEvent): BrowserWindow;
  waitUntilReady?(extension: Electron.Extension): Promise<void>;
  isExtensionReady?(id: string): boolean;
  getBadge?(id: string, tabId: number): ExtensionActionBadge;
  onPopupCreated?(guest: WebContents, popup: WebContents): void;
}

/** Open real extension documents in the browser profile, isolated from Paseo's preload. */
export function registerBrowserExtensionActions(options: ExtensionActionsOptions): void {
  const { profile, assertAppSender } = options;
  const windows = new Map<string, BrowserWindow>();
  const pending = new Map<string, Promise<BrowserWindow>>();
  const icons = new Map<string, Promise<string | null>>();
  profile.extensions.on("extension-loaded", (_event, extension) => icons.delete(extension.id));
  /** Reuse manifest icons across badge updates; reload/unload invalidates the static asset cache. */
  function toolbarIcon(extension: Electron.Extension): Promise<string | null> {
    let loading = icons.get(extension.id);
    if (!loading) {
      loading = (async () => {
        const metadata = getExtensionToolbarMetadata(extension.manifest, extension.name);
        const bytes = await readExtensionToolbarIcon(extension.path, metadata.iconPath);
        const image = bytes ? nativeImage.createFromBuffer(bytes) : null;
        return image && !image.isEmpty()
          ? image.resize({ width: 32, height: 32 }).toDataURL()
          : null;
      })();
      icons.set(extension.id, loading);
    }
    return loading;
  }

  profile.extensions.on("extension-unloaded", (_event, extension) => {
    icons.delete(extension.id);
    for (const [key, window] of windows) {
      if (key.endsWith(`:${extension.id}`)) {
        window.destroy();
      }
    }
  });

  ipcMain.handle("paseo:browser:extensions:actions", async (event, input: unknown) => {
    assertAppSender(event);
    const { browserId } = z.strictObject({ browserId: z.string().min(1) }).parse(input);
    const guest = getPaseoBrowserWebContentsForHostWindow(browserId, event.sender.id);
    if (!guest || guest.isDestroyed() || guest.session !== profile)
      throw new Error("The browser tab is no longer available.");
    const entries = await options.catalog.list();
    return Promise.all(
      profile.extensions
        .getAllExtensions()
        .filter((extension) => options.isExtensionReady?.(extension.id) ?? true)
        .map(async (extension) => {
          const metadata = getExtensionToolbarMetadata(extension.manifest, extension.name);
          const iconDataUrl = await toolbarIcon(extension);
          if (
            getPaseoBrowserWebContentsForHostWindow(browserId, event.sender.id) !== guest ||
            guest.isDestroyed()
          )
            throw new Error("The browser tab is no longer available.");
          return {
            id: extension.id,
            name: extension.name,
            title: metadata.title,
            iconDataUrl,
            badge: options.getBadge?.(extension.id, guest.id),
            pinned: entries.find((entry) => entry.id === extension.id)?.pinned === true,
            hasPopup: getExtensionPopupUrl(extension.id, extension.manifest) !== null,
          };
        }),
    );
  });

  ipcMain.handle("paseo:browser:extensions:open-popup", async (event, input: unknown) => {
    const owner = assertAppSender(event);
    const { id, browserId } = PopupInputSchema.parse(input);
    const guest = getPaseoBrowserWebContentsForHostWindow(browserId, event.sender.id);
    if (!guest || guest.session !== profile) {
      throw new Error("The browser tab is no longer available.");
    }
    const extension = profile.extensions.getExtension(id);
    if (!extension) {
      throw new Error("This extension is disabled or no longer installed.");
    }
    await options.waitUntilReady?.(extension);
    const key = `${owner.id}:${id}`;
    const opening = pending.get(key);
    if (opening) {
      await opening;
      return;
    }
    const previous = windows.get(key);
    if (previous && !previous.isDestroyed()) {
      previous.show();
      previous.focus();
      return;
    }
    const loading = openBrowserExtensionPopup({
      owner,
      profile,
      extension,
      onCreated: (popup) => {
        windows.set(key, popup);
        popup.on("closed", () => windows.delete(key));
        options.onPopupCreated?.(guest, popup.webContents);
      },
    });
    pending.set(key, loading);
    try {
      await loading;
    } finally {
      pending.delete(key);
    }
  });
}

interface ExtensionPopupOptions {
  owner: BrowserWindow;
  profile: Session;
  extension: Electron.Extension;
  show?: boolean;
  onCreated?(window: BrowserWindow): void;
}

/** Load an installed extension's packaged popup with browser-profile storage and APIs. */
export async function openBrowserExtensionPopup({
  owner,
  profile,
  extension,
  show = true,
  onCreated,
}: ExtensionPopupOptions): Promise<BrowserWindow> {
  const url = getExtensionPopupUrl(extension.id, extension.manifest);
  if (!url) {
    throw new Error("This extension does not provide a toolbar popup.");
  }
  return openBrowserExtensionDocumentWindow({
    owner,
    profile,
    extension,
    url,
    width: 420,
    height: 640,
    show,
    onCreated,
  });
}
