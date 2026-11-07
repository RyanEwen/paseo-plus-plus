import { SYNC_SIDEBAR_SETTING_KEYS } from "@getpaseo/protocol/app-settings-keys";
import { useEffect } from "react";
import { queryClient } from "@/data/query-client";
import { loadAppSettingsFromStorage } from "@/hooks/use-settings";
import { APP_SETTINGS_QUERY_KEY, type AppSettings } from "@/hooks/use-settings/storage";
import { selectHostFeature } from "@/runtime/host-features";
import {
  useSettingsDomainAdapter,
  type SettingsDomainAdapter,
  type SettingsDomainContext,
} from "@/hooks/use-settings/domain-adapters";
import { settingsSync } from "@/settings-sync/runtime";
import { createSyncedSidebarSettingsSave } from "@/settings-sync/sidebar-edits";
import { normalizeRemoteSidebarModes } from "@/settings-sync/sidebar-values";
import { useSessionStore } from "@/stores/session-store";
import { exportLegacySidebarPresentation } from "@/stores/sidebar-mode-preferences";
import {
  initializeSidebarModePreferences,
  installSidebarPreferenceCommitter,
  installSidebarSettingsHostSource,
  projectSidebarMode,
  useSidebarViewStore,
} from "@/stores/sidebar-view-store";

/** Canonical sidebar leaves a host with mode profiles stores under the "sidebar" domain. */
const SIDEBAR_KEYS = ["groupMode", "modeProfiles"] as const;

/**
 * Flat app preferences that older clients read for the sidebar. Mode profiles own them now, so
 * the plain app export leaves them out; publication to an older host restores them from the
 * active mode instead.
 */
const LEGACY_PRESENTATION_KEYS = [
  "workspaceTitleSource",
  "sidebarInitialWorkspaceCount",
  "sidebarWorkspaceTrailing",
  "sidebarRowItems",
  "sidebarChecksDisplay",
] as const;

/**
 * Whether the selected settings host stores separate Project and Status profiles.
 *
 * @param selectedHost the settings host, or null while settings stay on this device (always
 *   supported, because nothing is published).
 */
function sidebarModeProfilesSupported(selectedHost: string | null): boolean {
  // COMPAT(appSettingsSidebarModeProfiles): added in v0.11.2, remove after 2027-10-16.
  return (
    selectedHost === null ||
    selectHostFeature(useSessionStore.getState(), selectedHost, "appSettingsSidebarModeProfiles")
  );
}

/** Load the persisted sidebar store, failing loudly so sync keeps editing blocked. */
async function hydrateSidebarViewStore(): Promise<void> {
  if (useSidebarViewStore.persist.hasHydrated()) return;
  await useSidebarViewStore.persist.rehydrate();
  if (!useSidebarViewStore.persist.hasHydrated()) {
    throw new Error("Unable to load saved sidebar preferences");
  }
}

/**
 * Seed both mode profiles from legacy flat preferences once, after the app settings and the
 * sidebar store have both loaded. Later calls are no-ops.
 */
async function initializeDeviceSidebarModes(): Promise<void> {
  await queryClient.getQueryCache().find({ queryKey: APP_SETTINGS_QUERY_KEY })?.promise;
  const settings =
    queryClient.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY) ??
    (await loadAppSettingsFromStorage());
  await hydrateSidebarViewStore();
  initializeSidebarModePreferences(settings);
}

/**
 * Device values for the "sidebar" domain. Backups keep the canonical profiles. Publication to a
 * host without mode profiles sends the legacy flat sidebar fields instead.
 */
async function readSidebarDeviceValues(
  context: SettingsDomainContext,
): Promise<Record<string, unknown>> {
  await hydrateSidebarViewStore();
  const state = useSidebarViewStore.getState();
  const sidebar: Record<string, unknown> = {};
  for (const key of SIDEBAR_KEYS) sidebar[key] = state[key];
  if (context.purpose === "backup") return sidebar;

  if (!sidebarModeProfilesSupported(context.selectedHost)) {
    delete sidebar.modeProfiles;
    for (const key of SYNC_SIDEBAR_SETTING_KEYS) {
      if (key !== "modeProfiles") sidebar[key] = state[key];
    }
  }
  return sidebar;
}

/** Publication to an older host carries the active mode's presentation as flat app fields. */
function filterSidebarAppExport(
  app: Record<string, unknown>,
  context: SettingsDomainContext,
): Record<string, unknown> {
  if (context.purpose !== "publish") return app;
  if (sidebarModeProfilesSupported(context.selectedHost)) return app;
  const state = useSidebarViewStore.getState();
  return { ...app, ...exportLegacySidebarPresentation(state.modeProfiles[state.groupMode]) };
}

/** Project adopted host values; each mode keeps this device's own host/project filters. */
function applySidebarValues(values: Record<string, unknown>, app: AppSettings): void {
  const sidebar = normalizeRemoteSidebarModes(values.sidebar, app);
  useSidebarViewStore.setState({
    ...projectSidebarMode({
      ...sidebar,
      localModeFilters: useSidebarViewStore.getState().localModeFilters,
    }),
    modeProfilesInitialized: true,
  });
}

/** Serialize sidebar commands through the sync outbox before they change the projection. */
function observeSidebarEdits(): () => void {
  return installSidebarPreferenceCommitter(
    createSyncedSidebarSettingsSave(settingsSync, useSidebarViewStore, () =>
      sidebarModeProfilesSupported(settingsSync.getState().selectedHost),
    ),
  );
}

/**
 * The sidebar display preferences adapter. Module-level so the registration hook receives a
 * stable object and registers it once per mount.
 */
const SIDEBAR_SETTINGS_DOMAIN_ADAPTER: SettingsDomainAdapter = {
  id: "sidebar",
  ownedAppKeys: LEGACY_PRESENTATION_KEYS,
  initialize: initializeDeviceSidebarModes,
  readDeviceValues: readSidebarDeviceValues,
  filterAppExport: filterSidebarAppExport,
  applyValues: applySidebarValues,
  observeEdits: observeSidebarEdits,
};

/**
 * Register the sidebar adapter while mounted. Mount it above <SettingsSyncBootstrap /> so its
 * initialize() runs before the first load. The hook registers from an effect, never at module
 * import, because Fast Refresh re-runs modules and the registry rejects duplicate ids.
 */
export function SidebarSettingsSyncRegistration(): null {
  useSettingsDomainAdapter(SIDEBAR_SETTINGS_DOMAIN_ADAPTER);
  useEffect(() => installSidebarSettingsHostSource(isSettingsHostSelected), []);
  return null;
}

/** A selected settings host owns the synced profiles; edits must go through its outbox. */
function isSettingsHostSelected(): boolean {
  return settingsSync.getState().selectedHost !== null;
}
