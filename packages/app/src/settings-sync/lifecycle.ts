import { queryClient } from "@/data/query-client";
import { loadAppSettingsFromStorage } from "@/hooks/use-settings";
import { registerSettingsEditingBlocker } from "@/hooks/use-settings/editing-blocker";
import { APP_SETTINGS_QUERY_KEY } from "@/hooks/use-settings/storage";
import { createSyncedAppSettingsSave } from "./app-edits";
import {
  initializeSettingsSyncDomains,
  observeSettingsSyncDomainEdits,
  saveLocalDeviceSettings,
  saveLocalUsageHost,
  settingsSync,
} from "./runtime";
import { settingsSyncGate, type SettingsSyncGateInstallation } from "./gate";
import { SYNC_STATUS_POLICY } from "./status-policy";

/**
 * Start the app-wide settings sync owner: register the editing blocker and save handler, keep
 * the editing gate current, run domain edit observers, and hydrate local sync state.
 * `onHydrated` runs once local sync state has loaded. Returns the stop function.
 */
export function startSettingsSync(onHydrated: () => void): () => void {
  // Registered from the owner's start, not at module load, so Fast Refresh cannot register twice.
  const unregisterBlocker = registerSettingsEditingBlocker({
    isBlocked: () => settingsSyncGate.getState().editingBlocked,
    subscribe: settingsSyncGate.subscribe,
  });
  const handler = settingsSyncGate.install(
    createSyncedAppSettingsSave({
      model: settingsSync,
      loadSettings: loadAppSettingsFromStorage,
      saveLocalUsageHost,
      saveLocalSettings: saveLocalDeviceSettings,
    }),
  );
  const owner = new AbortController();
  const progress = { active: true, hydrated: false, hydrating: false };
  const isCurrent = () => progress.active && handler.isCurrent();

  const updateGate = () => {
    if (isCurrent()) publishSyncGate(handler, progress.hydrated);
  };
  updateGate();
  const stopGate = settingsSync.subscribe(updateGate);
  const stopDomainEdits = observeSettingsSyncDomainEdits();

  const startHydration = () => {
    if (!isCurrent() || progress.hydrated || progress.hydrating) return;
    progress.hydrating = true;
    void hydrateSettingsSync(owner.signal, isCurrent)
      .then((hydrated) => {
        if (!hydrated) return;
        progress.hydrated = true;
        onHydrated();
        updateGate();
      })
      .catch(console.error)
      .finally(() => {
        progress.hydrating = false;
      });
  };
  const stopRetry = resumeAfterLocalSettingsRecovery(startHydration);
  startHydration();

  return () => {
    progress.active = false;
    owner.abort();
    handler.release();
    unregisterBlocker();
    stopGate();
    stopRetry();
    stopDomainEdits();
  };
}

/** Publish read availability and the editing gate for the current sync state. */
function publishSyncGate(handler: SettingsSyncGateInstallation, hydrated: boolean): void {
  const state = settingsSync.getState();
  handler.updateReadAvailability({
    hydrated,
    generation: settingsSync.getGeneration(),
    status: state.status,
  });
  settingsSyncGate.setEditingBlocked(
    !hydrated || !state.canWrite || !SYNC_STATUS_POLICY[state.status].allowsEdits,
  );
}

/**
 * Let registered domains load, then load local sync state. Resolves true when both finished
 * while this owner is still current. A domain whose local store fails rejects, which keeps
 * editing blocked until a later retry succeeds.
 */
async function hydrateSettingsSync(
  signal: AbortSignal,
  isCurrent: () => boolean,
): Promise<boolean> {
  await initializeSettingsSyncDomains();
  if (!isCurrent()) return false;
  await settingsSync.load(signal);
  return isCurrent();
}

/**
 * A failed cold read of local app settings keeps editing blocked. Resume hydration only after
 * the owning query succeeds (including the page's explicit Retry), without remounting the owner.
 */
function resumeAfterLocalSettingsRecovery(start: () => void): () => void {
  return queryClient.getQueryCache().subscribe((event) => {
    const recovered =
      event.type === "updated" &&
      event.action.type === "success" &&
      event.query.queryKey[0] === APP_SETTINGS_QUERY_KEY[0];
    if (recovered) start();
  });
}
