import { BrowserWindow, dialog, ipcMain, type Session } from "electron";
import { z } from "zod";
import { toLoadedExtension, type BrowserExtensionCatalog } from "./catalog.js";

const ExtensionIdSchema = z.string().regex(/^[a-p]{32}$/);
const PinInputSchema = z.object({ id: ExtensionIdSchema, pinned: z.boolean() });
const EnableInputSchema = z.object({ id: ExtensionIdSchema, enabled: z.boolean() });

interface SettingsIpcOptions {
  profile: Session;
  catalog: BrowserExtensionCatalog;
  /** Throws unless the sender is a Paseo app window; returns that window. */
  assertAppSender(event: Electron.IpcMainInvokeEvent): BrowserWindow;
  /** Load an extension folder and wait until its runtime is ready. */
  loadReadyExtension(extensionPath: string): Promise<Electron.Extension>;
  /** Clear per-extension state that outlives the catalog entry. */
  forgetExtension(id: string): Promise<unknown>;
  openStoreWindow(): Promise<void>;
}

/** Register the Settings > Browser > Extensions IPC handlers for Paseo app windows. */
export function registerBrowserExtensionSettingsIpc(options: SettingsIpcOptions): void {
  const { profile, catalog, assertAppSender } = options;

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
    await options.forgetExtension(id);
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
    const extension = await options.loadReadyExtension(result.filePaths[0]);
    try {
      await catalog.remember(toLoadedExtension(extension));
    } catch (error) {
      profile.extensions.removeExtension(extension.id);
      throw error;
    }
  });
  ipcMain.handle("paseo:browser:extensions:open-store", async (event) => {
    assertAppSender(event);
    await options.openStoreWindow();
  });
}
