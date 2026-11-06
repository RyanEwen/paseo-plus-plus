import { DEFAULT_CLIENT_SETTINGS, type AppSettings } from "@/hooks/use-settings/storage";
import { DEVICE_LOCAL_APP_SETTING_KEYS, DEVICE_LOCAL_FORK_SETTING_KEYS } from "./scope";

type StoredDeviceKey = Extract<(typeof DEVICE_LOCAL_APP_SETTING_KEYS)[number], keyof AppSettings>;

/**
 * Device-local keys this build stores. The shared registry also lists wire-only keys, such as
 * the removed legacy terminal renderer, and keys of feature layers absent from this build; those
 * still need outbox filtering but have no stored value to preserve.
 */
const storedDeviceKeys = DEVICE_LOCAL_APP_SETTING_KEYS.filter((key): key is StoredDeviceKey =>
  Object.hasOwn(DEFAULT_CLIENT_SETTINGS, key),
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
