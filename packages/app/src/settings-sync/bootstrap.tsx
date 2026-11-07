import { bindSettingsHost } from "./binding";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { startSettingsSync } from "./lifecycle";
import { settingsSync } from "./runtime";

/** React view of the settings sync state: selected host, status, pending count and errors. */
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

  useEffect(() => startSettingsSync(() => setInitialized(true)), []);

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
