import path from "node:path";
import { app, BrowserWindow, dialog, session } from "electron";
import log from "electron-log";
import { installChromeWebStore, uninstallExtension } from "electron-chrome-web-store";
import { PASEO_BROWSER_PROFILE_PARTITION } from "../browser-profile.js";
import { BrowserExtensionCatalog, toLoadedExtension } from "./catalog.js";
import { registerBrowserExtensionActions } from "./actions.js";
import { registerBrowserExtensionCompatibility } from "./compatibility.js";
import { registerBrowserExtensionSettingsIpc } from "./settings-ipc.js";
import { createStoreInstallPrompt, createStoreWindowOpener } from "./store-window.js";

/** Install the Store only in the browser session, before any browser guest can navigate. */
export async function registerBrowserExtensions(): Promise<void> {
  const profile = session.fromPartition(PASEO_BROWSER_PROFILE_PARTITION);
  const extensionsPath = path.join(app.getPath("userData"), "browser-extensions");
  const managedLoads = new Set<string>();

  const notifyChanged = () => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (
        !window.isDestroyed() &&
        !window.webContents.isDestroyed() &&
        window.webContents.session === session.defaultSession
      ) {
        window.webContents.send("paseo:browser:extensions:changed");
      }
    }
  };

  // The callback runs only after catalog construction, when restore/install starts loading extensions.
  let catalog: BrowserExtensionCatalog;
  const compatibility = registerBrowserExtensionCompatibility(profile, {
    onStorageFailure: (id, error) => catalog.recordRuntimeFailure(id, error),
    onStorageReady: notifyChanged,
    onActionChanged: notifyChanged,
  });
  /** A native load is not usable until its authoritative storage listener is ready. */
  async function loadReadyExtension(extensionPath: string): Promise<Electron.Extension> {
    managedLoads.add(extensionPath);
    try {
      const extension = await profile.extensions.loadExtension(extensionPath);
      await compatibility.waitUntilReady(extension);
      return extension;
    } finally {
      managedLoads.delete(extensionPath);
    }
  }
  catalog = new BrowserExtensionCatalog(
    path.join(app.getPath("userData"), "browser-extensions.json"),
    extensionsPath,
    {
      isLoaded: compatibility.isExtensionReady,
      load: async (extensionPath) => toLoadedExtension(await loadReadyExtension(extensionPath)),
      unload: (id) => profile.extensions.removeExtension(id),
      uninstall: (id) => uninstallExtension(id, { session: profile, extensionsPath }),
    },
    notifyChanged,
  );
  app.once("before-quit", () => catalog.dispose());
  profile.extensions.on("extension-loaded", notifyChanged);
  profile.extensions.on("extension-unloaded", notifyChanged);
  let startupError: unknown;
  try {
    await catalog.restore();
  } catch (error) {
    // Do not overwrite an unreadable catalog or prevent the rest of Paseo from starting.
    startupError = error;
    log.error("[browser-extensions] could not restore catalog", error);
  }

  profile.extensions.on("extension-loaded", (_event, extension) => {
    if (managedLoads.has(extension.path)) {
      return;
    }
    async function rememberReady(): Promise<void> {
      await compatibility.waitUntilReady(extension);
      await catalog.remember(toLoadedExtension(extension));
    }
    void rememberReady().catch((error) => {
      profile.extensions.removeExtension(extension.id);
      log.error("[browser-extensions] could not save installed extension", error);
      dialog.showErrorBox("Extension could not be saved", String(error));
    });
  });

  await installChromeWebStore({
    session: profile,
    extensionsPath,
    // The catalog owns restore and disabled choices. Store updates would bypass those choices.
    loadExtensions: false,
    autoUpdate: false,
    beforeInstall: createStoreInstallPrompt({
      catalog,
      isCatalogUnavailable: () => Boolean(startupError),
    }),
  });

  /** Settings APIs belong to app windows, never to remote pages or installed extensions. */
  function assertAppSender(event: Electron.IpcMainInvokeEvent): BrowserWindow {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (
      !owner ||
      event.sender.session !== session.defaultSession ||
      event.senderFrame !== event.sender.mainFrame
    ) {
      throw new Error("Extension settings are only available to Paseo app windows.");
    }
    if (startupError) {
      throw new Error(`Could not restore browser extensions: ${String(startupError)}`);
    }
    return owner;
  }

  registerBrowserExtensionActions({
    profile,
    catalog,
    assertAppSender,
    onPopupCreated: (guest, popup) => compatibility.registerPopup(popup, guest),
    waitUntilReady: compatibility.waitUntilReady,
    isExtensionReady: compatibility.isExtensionReady,
    getBadge: compatibility.getActionBadge,
  });

  registerBrowserExtensionSettingsIpc({
    profile,
    catalog,
    assertAppSender,
    loadReadyExtension,
    // Both independent stores must clear even if one cleanup fails.
    forgetExtension: (id) =>
      Promise.all([
        compatibility.forgetExtensionContextMenus(id),
        compatibility.forgetExtensionAlarms(id),
      ]),
    openStoreWindow: createStoreWindowOpener(profile),
  });
}
