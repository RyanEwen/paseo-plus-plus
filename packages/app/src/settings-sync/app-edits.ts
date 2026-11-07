import type { QueryClient } from "@tanstack/react-query";
import {
  APP_SETTINGS_QUERY_KEY,
  DEFAULT_CLIENT_SETTINGS,
  type AppSettings,
  type AppSettingsUpdate,
} from "@/hooks/use-settings/storage";
import { settingsDiff } from "@getpaseo/protocol/app-settings-values";
import { deviceAppSettingsUpdate, type DeviceAppSettingsUpdate } from "./device-settings";
import { isSyncedSettingsPath } from "./scope";
import type { SettingsSyncModel } from "./model";

/** What the synced save needs: the model, a settings reader and the device-local writers. */
export interface SyncedAppSettingsSaveInput {
  model: SettingsSyncModel;
  loadSettings: () => Promise<AppSettings>;
  /** Persists the device-local Usage report host; required once a save changes it. */
  saveLocalUsageHost?: (queryClient: QueryClient, serverId: string | null) => Promise<void>;
  /** Persists device-local leaves; required once a save changes one. */
  saveLocalSettings?: (queryClient: QueryClient, updates: DeviceAppSettingsUpdate) => Promise<void>;
}

/** Evaluate functional settings updates after prior durable edits, retaining their original host. */
export function createSyncedAppSettingsSave({
  model,
  loadSettings,
  saveLocalUsageHost,
  saveLocalSettings,
}: SyncedAppSettingsSaveInput) {
  let queue: Promise<unknown> = Promise.resolve();
  return async (queryClient: QueryClient, updates: AppSettingsUpdate): Promise<boolean> => {
    // A save can arrive before the bootstrap loads sync state; load it first so a device with no
    // selected host keeps using ordinary local storage instead of failing.
    if (model.getState().status === "loading") await model.load();
    if (model.editsStayOnDevice()) return false;
    const generation = model.getGeneration();
    const result = queue.then(() => saveEdit(queryClient, updates, generation));
    queue = result.catch(() => undefined);
    return result;
  };

  async function saveEdit(
    queryClient: QueryClient,
    updates: AppSettingsUpdate,
    generation: number,
  ): Promise<boolean> {
    if (generation !== model.getGeneration())
      throw new Error("Settings host changed before saving");
    const current =
      queryClient.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY) ?? (await loadSettings());
    if (generation !== model.getGeneration())
      throw new Error("Settings host changed while loading preferences");
    const patch = typeof updates === "function" ? updates(current) : updates;
    const next = { ...current, ...patch };
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const key of Object.keys(DEFAULT_CLIENT_SETTINGS) as (keyof AppSettings)[]) {
      before[key] = current[key];
      after[key] = next[key];
    }
    const patches = settingsDiff({ app: before }, { app: after }, model.getSnapshot()).filter(
      (item) => isSyncedSettingsPath(item.path),
    );
    const localUpdates = deviceAppSettingsUpdate(current, next);
    if (Object.keys(localUpdates).length) {
      if (!saveLocalSettings) throw new Error("Local device preferences are unavailable");
      await saveLocalSettings(queryClient, localUpdates);
    }
    if (next.usage.serverId !== current.usage.serverId) {
      if (!saveLocalUsageHost) throw new Error("Local Usage preferences are unavailable");
      await saveLocalUsageHost(queryClient, next.usage.serverId);
    }
    if (generation !== model.getGeneration())
      throw new Error("Settings host changed before saving");
    if (patches.length) await model.edit(patches);
    return true;
  }
}
