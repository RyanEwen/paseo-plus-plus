import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, session } from "electron";
import log from "electron-log";
import { installChromeWebStore, uninstallExtension } from "electron-chrome-web-store";
import { z } from "zod";
import { PASEO_BROWSER_PROFILE_PARTITION } from "../browser-profile.js";
import { registerBrowserWebviewNavigationGuards } from "../browser-webviews/index.js";
import { BrowserExtensionCatalog } from "./catalog.js";
import { registerBrowserExtensionActions } from "./actions.js";
import { registerBrowserExtensionCompatibility } from "./compatibility.js";

const ExtensionIdSchema = z.string().regex(/^[a-p]{32}$/);
const PinInputSchema = z.object({ id: ExtensionIdSchema, pinned: z.boolean() });
const EnableInputSchema = z.object({ id: ExtensionIdSchema, enabled: z.boolean() });
const STORE_URL = "https://chromewebstore.google.com/";

/** Install the Store only in the browser session, before any browser guest can navigate. */
export async function registerBrowserExtensions(): Promise<void> {
  const profile = session.fromPartition(PASEO_BROWSER_PROFILE_PARTITION);
  const extensionsPath = path.join(app.getPath("userData"), "browser-extensions");
  const managedLoads = new Set<string>();
  let storeWindow: BrowserWindow | null = null;

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
      load: loadReadyExtension,
      unload: (id) => profile.extensions.removeExtension(id),
      uninstall: (id) => uninstallExtension(id, { session: profile, extensionsPath }),
    },
    notifyChanged,
  );
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
      await catalog.remember(extension);
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
    async beforeInstall(details) {
      if (startupError) {
        return { action: "deny" };
      }
      if (new URL(details.frame.url).origin !== new URL(STORE_URL).origin) {
        return { action: "deny" };
      }
      const installed = (await catalog.list()).find((entry) => entry.id === details.id);
      if (installed) {
        dialog.showErrorBox(
          "Extension already installed",
          "Enable or remove this extension in Settings > Browser.",
        );
        return { action: "deny" };
      }
      const permissions = [
        ...(details.manifest.permissions ?? []),
        ...(details.manifest.host_permissions ?? []),
      ];
      const options: Electron.MessageBoxOptions = {
        type: "question",
        title: "Add extension",
        message: `Add ${details.localizedName}?`,
        detail: `Requested permissions:\n${permissions.join("\n") || "None"}\n\nSome Chrome extension features are unsupported in Paseo. Installation does not guarantee compatibility.`,
        buttons: ["Cancel", "Add extension"],
        defaultId: 0,
        cancelId: 0,
      };
      const result = details.browserWindow
        ? await dialog.showMessageBox(details.browserWindow, options)
        : await dialog.showMessageBox(options);
      return { action: result.response === 1 ? "allow" : "deny" };
    },
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

  ipcMain.handle("paseo:browser:extensions:list", (event) => {
    assertAppSender(event);
    return catalog.list();
  });
  ipcMain.handle("paseo:browser:extensions:set-pinned", (event, input: unknown) => {
    assertAppSender(event);
    const { id, pinned } = PinInputSchema.parse(input);
    return catalog.setPinned(id, pinned);
  });
  ipcMain.handle("paseo:browser:extensions:set-enabled", (event, input: unknown) => {
    assertAppSender(event);
    const { id, enabled } = EnableInputSchema.parse(input);
    return catalog.setEnabled(id, enabled);
  });
  ipcMain.handle("paseo:browser:extensions:remove", async (event, input: unknown) => {
    assertAppSender(event);
    const id = ExtensionIdSchema.parse(input);
    await catalog.remove(id);
    // Both independent stores must clear even if one cleanup fails.
    await Promise.all([
      compatibility.forgetExtensionContextMenus(id),
      compatibility.forgetExtensionAlarms(id),
    ]);
  });
  ipcMain.handle("paseo:browser:extensions:load-unpacked", async (event) => {
    const owner = assertAppSender(event);
    const result = await dialog.showOpenDialog(owner, {
      title: "Select extension folder",
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) {
      return;
    }
    const extensionPath = result.filePaths[0];
    managedLoads.add(extensionPath);
    try {
      const extension = await loadReadyExtension(extensionPath);
      try {
        await catalog.remember(extension);
      } catch (error) {
        profile.extensions.removeExtension(extension.id);
        throw error;
      }
    } finally {
      managedLoads.delete(extensionPath);
    }
  });
  ipcMain.handle("paseo:browser:extensions:open-store", async (event) => {
    assertAppSender(event);
    if (storeWindow && !storeWindow.isDestroyed()) {
      storeWindow.show();
      storeWindow.focus();
      return;
    }
    const window = new BrowserWindow({
      title: "Chrome Web Store",
      width: 1100,
      height: 800,
      webPreferences: {
        session: profile,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    storeWindow = window;
    registerBrowserWebviewNavigationGuards(window.webContents);
    window.on("closed", () => {
      storeWindow = null;
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    try {
      await window.loadURL(STORE_URL);
    } catch (error) {
      window.close();
      throw error;
    }
  });
}
