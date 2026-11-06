import {
  preserveDeviceAppSettings,
  applyDeviceAppSettingsUpdate,
  type DeviceAppSettingsUpdate,
} from "./device-settings";
import { exportSharedAppSettings } from "./scope";
import {
  selectChatPreferencesSupport,
  exportSupportedChatPreferences,
} from "@/appearance/chat-preferences-support";
import type { QueryClient } from "@tanstack/react-query";
import { SYNC_APP_SETTING_KEYS } from "@getpaseo/protocol/app-settings";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { queryClient } from "@/data/query-client";
import {
  APP_SETTINGS_QUERY_KEY,
  normalizeAppSettings,
  saveAppSettings,
  type AppSettings,
  type SettingsDeps,
} from "@/hooks/use-settings/storage";
import { loadAppSettingsFromStorage } from "@/hooks/use-settings";
import { DEFAULT_DESKTOP_SETTINGS } from "@/desktop/settings/desktop-settings";
import { isSettingsObject } from "@getpaseo/protocol/app-settings-values";
import { SettingsSyncModel } from "./model";
import { useSessionStore } from "@/stores/session-store";

const STORAGE_KEY = "app-settings-sync";
// Optional legacy wire keys stay accepted by hosts, but this client stores no value for them.
const WIRE_ONLY_APP_KEYS = new Set<string>(["useLegacyTerminalRenderer", "toolCallDetailLevel"]);

const deps: SettingsDeps = {
  storage: AsyncStorage,
  desktop: {
    isElectron: () => false,
    loadDesktopSettings: async () => DEFAULT_DESKTOP_SETTINGS,
    migrateLegacyDesktopSettings: async () => {},
  },
};

/**
 * Read known preferences, excluding credentials, host selection, layouts and drafts.
 * Backup preserves every choice; publish alone omits a field unsupported by the chosen host.
 */
export async function getDeviceSettingsValues(
  purpose: "backup" | "publish" = "backup",
): Promise<Record<string, unknown>> {
  await queryClient.getQueryCache().find({ queryKey: APP_SETTINGS_QUERY_KEY })?.promise;
  const settings =
    queryClient.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY) ??
    (await loadAppSettingsFromStorage());
  const app: Record<string, unknown> = {};
  // Registry keys of feature layers absent from this build have no stored value to send.
  const stored: Record<string, unknown> = { ...settings };
  for (const key of SYNC_APP_SETTING_KEYS) {
    if (WIRE_ONLY_APP_KEYS.has(key)) continue;
    if (Object.hasOwn(stored, key)) app[key] = stored[key];
  }
  app.usage = { displayAs: settings.usage.displayAs, pins: settings.usage.pins };
  if (purpose === "backup") return { app };
  const chatSupported = selectChatPreferencesSupport(
    useSessionStore.getState(),
    settingsSync.getState().selectedHost,
  );
  return {
    app: exportSupportedChatPreferences(exportSharedAppSettings(app), chatSupported, purpose),
  };
}

/** Project host values through the existing normalization and durable app write path. */
async function applyValues(values: Record<string, unknown>): Promise<void> {
  // Let any initial hydration finish before replacing the same cache and durable storage.
  await queryClient.getQueryCache().find({ queryKey: APP_SETTINGS_QUERY_KEY })?.promise;
  const app = normalizeAppSettings(isSettingsObject(values.app) ? values.app : {});
  // Historical hosts may still store serverId. It remains untouched on the host and device.
  await saveAppSettings({
    queryClient,
    updates: (current) => preserveDeviceAppSettings(app, current),
    deps,
  });
}

export const settingsSync = new SettingsSyncModel({
  readLocal: async () => {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    return raw === null ? null : JSON.parse(raw);
  },
  writeLocal: async (value) => AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(value)),
  getDeviceValues: getDeviceSettingsValues,
  applyValues,
});

/** The report host stays local even when the rest of Usage preferences sync. */
export async function saveLocalUsageHost(
  client: QueryClient,
  serverId: string | null,
): Promise<void> {
  await saveAppSettings({
    queryClient: client,
    updates: (current) => ({ usage: { ...current.usage, serverId } }),
    deps,
  });
}

/** Persist local leaves inside the storage queue to retain newer shared siblings. */
export async function saveLocalDeviceSettings(
  client: QueryClient,
  updates: DeviceAppSettingsUpdate,
): Promise<void> {
  await saveAppSettings({
    queryClient: client,
    updates: (current) => applyDeviceAppSettingsUpdate(updates, current),
    deps,
  });
}
