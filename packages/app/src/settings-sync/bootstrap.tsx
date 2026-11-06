import { bindSettingsHost } from "./binding";
import { queryClient } from "@/data/query-client";
import { APP_SETTINGS_QUERY_KEY } from "@/hooks/use-settings/storage";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { loadAppSettingsFromStorage } from "@/hooks/use-settings";
import { registerSettingsEditingBlocker } from "@/hooks/use-settings/editing-blocker";
import { createSyncedAppSettingsSave } from "./app-edits";
import {
  settingsSync,
  initializeSettingsSyncDomains,
  observeSettingsSyncDomainEdits,
  saveLocalUsageHost,
  saveLocalDeviceSettings,
} from "./runtime";
import {
  getSettingsEditingBlocked,
  installSettingsSyncSaveHandler,
  setSettingsEditingBlocked,
  setSettingsHostSelected,
  subscribeSettingsEditingBlocked,
} from "./save-handler";

export function useSettingsSyncState() {
  return useSyncExternalStore(settingsSync.subscribe, settingsSync.getState, settingsSync.getState);
}

/** One app-wide owner, independent of the active workspace or the settings screen's lifetime. */
export function SettingsSyncBootstrap() {
  const syncState = useSettingsSyncState();
  const host = syncState.selectedHost ?? "";
  const client = useHostRuntimeClient(host);
  const connected = useHostRuntimeIsConnected(host);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    // Settings editors wait while the selected host loads or refuses writes. Registering here,
    // rather than at module load, keeps the single-registration rule intact across Fast Refresh.
    const unregisterBlocker = registerSettingsEditingBlocker({
      isBlocked: getSettingsEditingBlocked,
      subscribe: subscribeSettingsEditingBlocked,
    });
    const uninstall = installSettingsSyncSaveHandler(
      createSyncedAppSettingsSave(
        settingsSync,
        loadAppSettingsFromStorage,
        saveLocalUsageHost,
        saveLocalDeviceSettings,
      ),
    );
    let hydrated = false;
    let initializing = false;
    let active = true;
    const owner = new AbortController();
    const updateGate = () => {
      if (!active || !uninstall.isCurrent()) return;
      const state = settingsSync.getState();
      uninstall.updateReadAvailability({
        hydrated,
        generation: settingsSync.getGeneration(),
        status: state.status,
      });
      setSettingsHostSelected(state.selectedHost !== null);
      setSettingsEditingBlocked(
        !hydrated || !state.canWrite || !["local", "ready", "offline"].includes(state.status),
      );
    };
    updateGate();
    const stopGate = settingsSync.subscribe(updateGate);
    const stopDomainEdits = observeSettingsSyncDomainEdits();
    const initialize = async () => {
      // A domain whose local store fails to load keeps editing blocked until Retry succeeds.
      await initializeSettingsSyncDomains();
      if (!active || !uninstall.isCurrent()) return;
      await settingsSync.load(owner.signal);
      if (!active || !uninstall.isCurrent()) return;
      hydrated = true;
      setInitialized(true);
      updateGate();
    };
    const startInitialization = () => {
      if (!active || !uninstall.isCurrent() || hydrated || initializing) return;
      initializing = true;
      void initialize()
        .catch(console.error)
        .finally(() => {
          initializing = false;
        });
    };
    // A failed cold read keeps editing blocked. Resume only after the owning query succeeds
    // (including the page's explicit Retry), without remounting this app-wide authority owner.
    const stopRetry = queryClient.getQueryCache().subscribe((event) => {
      if (
        event.type === "updated" &&
        event.action.type === "success" &&
        event.query.queryKey[0] === APP_SETTINGS_QUERY_KEY[0]
      )
        startInitialization();
    });
    startInitialization();
    return () => {
      active = false;
      owner.abort();
      uninstall();
      unregisterBlocker();
      stopGate();
      stopRetry();
      stopDomainEdits();
    };
  }, []);

  useEffect(() => {
    if (!initialized || !host) return;
    if (!client || !connected) {
      void settingsSync.connect(host, null);
      return;
    }
    return bindSettingsHost({
      client,
      onSnapshot: (snapshot) => {
        void settingsSync.receive(host, snapshot).catch(console.error);
      },
      onTransport: (transport) => {
        void settingsSync.connect(host, transport);
      },
    });
  }, [initialized, host, client, connected]);
  return null;
}
