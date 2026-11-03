import type { AppSettings } from "@/hooks/use-settings/storage";
import { DEVICE_LOCAL_APP_SETTING_KEYS, DEVICE_LOCAL_FORK_SETTING_KEYS } from "./scope";
// Upstream removed this renderer from current storage; its wire key still needs outbox filtering.
const storedDeviceKeys = DEVICE_LOCAL_APP_SETTING_KEYS.filter(
  (key) => key !== "useLegacyTerminalRenderer",
);

/** Remote defaults and historical device fields must never replace the current local choices. */
export function preserveDeviceAppSettings(
  incoming: AppSettings,
  current: AppSettings,
): AppSettings {
  const next = { ...incoming, paseoPlusPlus: { ...incoming.paseoPlusPlus } };
  for (const key of storedDeviceKeys) Object.assign(next, { [key]: current[key] });
  for (const key of DEVICE_LOCAL_FORK_SETTING_KEYS)
    Object.assign(next.paseoPlusPlus, { [key]: current.paseoPlusPlus[key] });
  next.usage = { ...incoming.usage, serverId: current.usage.serverId };
  return next;
}

export type DeviceAppSettingsUpdate = Omit<Partial<AppSettings>, "paseoPlusPlus"> & {
  paseoPlusPlus?: Partial<AppSettings["paseoPlusPlus"]>;
};

/** Persist only changed local leaves; shared values still enter the durable host outbox. */
export function deviceAppSettingsUpdate(
  current: AppSettings,
  next: AppSettings,
): DeviceAppSettingsUpdate {
  const updates: DeviceAppSettingsUpdate = {};
  for (const key of storedDeviceKeys) {
    if (JSON.stringify(current[key]) !== JSON.stringify(next[key]))
      Object.assign(updates, { [key]: next[key] });
  }
  const fork: Partial<AppSettings["paseoPlusPlus"]> = {};
  let changed = false;
  for (const key of DEVICE_LOCAL_FORK_SETTING_KEYS) {
    if (next.paseoPlusPlus[key] !== current.paseoPlusPlus[key]) {
      Object.assign(fork, { [key]: next.paseoPlusPlus[key] });
      changed = true;
    }
  }
  if (changed) updates.paseoPlusPlus = fork;
  return updates;
}

/** Run inside the existing storage queue so a local toggle cannot restore stale shared siblings. */
export function applyDeviceAppSettingsUpdate(
  updates: DeviceAppSettingsUpdate,
  current: AppSettings,
): Partial<AppSettings> {
  const { paseoPlusPlus, ...settings } = updates;
  return paseoPlusPlus
    ? { ...settings, paseoPlusPlus: { ...current.paseoPlusPlus, ...paseoPlusPlus } }
    : settings;
}
