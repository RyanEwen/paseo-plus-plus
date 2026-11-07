import { BrowserWindow, dialog, type Session } from "electron";
import type { installChromeWebStore } from "electron-chrome-web-store";
import { registerBrowserWebviewNavigationGuards } from "../browser-webviews/index.js";
import type { BrowserExtensionCatalog } from "./catalog.js";

export const CHROME_WEB_STORE_URL = "https://chromewebstore.google.com/";

type BeforeInstall = NonNullable<
  NonNullable<Parameters<typeof installChromeWebStore>[0]>["beforeInstall"]
>;

/**
 * Ask before every Store install. Installs from other origins, already installed extensions,
 * and any install while the catalog could not be restored are refused without asking.
 */
export function createStoreInstallPrompt(options: {
  catalog: BrowserExtensionCatalog;
  isCatalogUnavailable(): boolean;
}): BeforeInstall {
  return async (details) => {
    if (options.isCatalogUnavailable()) {
      return { action: "deny" };
    }
    if (new URL(details.frame.url).origin !== new URL(CHROME_WEB_STORE_URL).origin) {
      return { action: "deny" };
    }
    const installed = (await options.catalog.list()).find((entry) => entry.id === details.id);
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
    const prompt: Electron.MessageBoxOptions = {
      type: "question",
      title: "Add extension",
      message: `Add ${details.localizedName}?`,
      detail: `Requested permissions:\n${permissions.join("\n") || "None"}\n\nSome Chrome extension features are unsupported in Paseo. Installation does not guarantee compatibility.`,
      buttons: ["Cancel", "Add extension"],
      defaultId: 0,
      cancelId: 0,
    };
    const result = details.browserWindow
      ? await dialog.showMessageBox(details.browserWindow, prompt)
      : await dialog.showMessageBox(prompt);
    return { action: result.response === 1 ? "allow" : "deny" };
  };
}

/**
 * Open the Chrome Web Store in the browser profile, reusing one window. The window gets the same
 * navigation guards as browser tabs and cannot open further windows.
 *
 * @returns A function that shows the existing Store window or opens a new one.
 */
export function createStoreWindowOpener(profile: Session): () => Promise<void> {
  let storeWindow: BrowserWindow | null = null;

  return async () => {
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
      await window.loadURL(CHROME_WEB_STORE_URL);
    } catch (error) {
      window.close();
      throw error;
    }
  };
}
