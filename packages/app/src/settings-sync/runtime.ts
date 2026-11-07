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
  type AppSettings,
} from "@/hooks/use-settings/storage";
import { loadAppSettingsFromStorage, saveAppSettingsLocally } from "@/hooks/use-settings";
import { isSettingsObject } from "@getpaseo/protocol/app-settings-values";
import { SettingsSyncModel } from "./model";
import {
  applyDomainValues,
  collectDomainDeviceValues,
  filterDomainAppExport,
  initializeDomains,
  ownedDomainAppKeys,
  trackDomainEdits,
} from "./domains";
import {
  listSettingsDomainAdapters,
  type SettingsDomainAdapter,
  type SettingsDomainContext,
} from "@/hooks/use-settings/domain-adapters";
import { useSessionStore } from "@/stores/session-store";

const STORAGE_KEY = "app-settings-sync";
// Optional legacy wire keys stay accepted by hosts, but this client stores no value for them.
const WIRE_ONLY_APP_KEYS = new Set<string>(["useLegacyTerminalRenderer", "toolCallDetailLevel"]);

/** Let every registered domain load its local state before sync reads or replaces it. */
export async function initializeSettingsSyncDomains(): Promise<void> {
  await initializeDomains(listSettingsDomainAdapters());
}

/** Run every registered domain's edit committer, including later registrations; returns stop. */
export function observeSettingsSyncDomainEdits(): () => void {
  return trackDomainEdits();
}

/** Let any initial app settings hydration finish before reading or replacing that cache. */
async function awaitAppSettingsHydration(): Promise<void> {
  await queryClient.getQueryCache().find({ queryKey: APP_SETTINGS_QUERY_KEY })?.promise;
}

/**
 * Plain app preferences from the synced key registry, minus wire-only keys and keys a domain
 * projects itself. Registry keys of feature layers absent from this build have no stored value.
 */
function pickSharedAppPreferences(
  settings: AppSettings,
  ownedKeys: ReadonlySet<string>,
): Record<string, unknown> {
  const app: Record<string, unknown> = {};
  const stored: Record<string, unknown> = { ...settings };
  for (const key of SYNC_APP_SETTING_KEYS) {
    if (WIRE_ONLY_APP_KEYS.has(key) || ownedKeys.has(key)) continue;
    if (Object.hasOwn(stored, key)) app[key] = stored[key];
  }
  // The Usage report host stays on the device; only its display choices sync.
  app.usage = { displayAs: settings.usage.displayAs, pins: settings.usage.pins };
  return app;
}

/** Publication drops device-only and host-unsupported fields, then applies domain filters. */
function publishableAppPreferences(
  app: Record<string, unknown>,
  domains: readonly SettingsDomainAdapter[],
  context: SettingsDomainContext,
): Record<string, unknown> {
  const chatSupported = selectChatPreferencesSupport(
    useSessionStore.getState(),
    context.selectedHost,
  );
  const shared = exportSupportedChatPreferences(
    exportSharedAppSettings(app),
    chatSupported,
    context.purpose,
  );
  return filterDomainAppExport(domains, shared, context);
}

/**
 * Read known preferences, excluding credentials, host selection, layouts and drafts.
 * Backup preserves every choice; publish alone omits a field unsupported by the chosen host.
 * Registered domains add their own values and publication filters.
 */
export async function getDeviceSettingsValues(
  purpose: "backup" | "publish" = "backup",
): Promise<Record<string, unknown>> {
  await awaitAppSettingsHydration();
  const settings =
    queryClient.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY) ??
    (await loadAppSettingsFromStorage());
  const domains = listSettingsDomainAdapters();
  await initializeDomains(domains);

  const app = pickSharedAppPreferences(settings, ownedDomainAppKeys(domains));
  const context: SettingsDomainContext = {
    purpose,
    selectedHost: settingsSync.getState().selectedHost,
  };
  const domainValues = await collectDomainDeviceValues(domains, context);
  if (purpose === "backup") return { ...domainValues, app };
  return { ...domainValues, app: publishableAppPreferences(app, domains, context) };
}

/** Project host values through the existing normalization and durable app write path. */
async function applyValues(values: Record<string, unknown>): Promise<void> {
  await awaitAppSettingsHydration();
  const app = normalizeAppSettings(isSettingsObject(values.app) ? values.app : {});
  // Historical hosts may still store serverId. It remains untouched on the host and device.
  await saveAppSettingsLocally({
    queryClient,
    updates: (current) => preserveDeviceAppSettings(app, current),
  });
  // Domains project their own values only after the app preferences are durable.
  await applyDomainValues(listSettingsDomainAdapters(), values, app);
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
  await saveAppSettingsLocally({
    queryClient: client,
    updates: (current) => ({ usage: { ...current.usage, serverId } }),
  });
}

/** Persist local leaves inside the storage queue to retain newer shared siblings. */
export async function saveLocalDeviceSettings(
  client: QueryClient,
  updates: DeviceAppSettingsUpdate,
): Promise<void> {
  await saveAppSettingsLocally({
    queryClient: client,
    updates: (current) => applyDeviceAppSettingsUpdate(updates, current),
  });
}
