import {
  isSettingsObject,
  isSyncedSettingsPath as isProtocolSyncedSettingsPath,
} from "@getpaseo/protocol/app-settings-values";
import type { AppSettingsPatch } from "@getpaseo/protocol/app-settings";
import {
  DEVICE_LOCAL_APP_SETTING_KEYS,
  DEVICE_LOCAL_FORK_SETTING_KEYS,
} from "@/paseo-plus-plus/device-local-settings";

/** Keep old host documents readable; clients stop sending and applying device-specific leaves. */
export function isSyncedSettingsPath(path: readonly string[]): boolean {
  if (!isProtocolSyncedSettingsPath(path)) return false;
  if (path[0] !== "app") return true;
  if (DEVICE_LOCAL_APP_SETTING_KEYS.some((key) => key === path[1])) return false;
  return !(
    path[1] === "paseoPlusPlus" &&
    (path.length === 2 || DEVICE_LOCAL_FORK_SETTING_KEYS.some((key) => key === path[2]))
  );
}

/** Only mixed ancestors need splitting; shared object replacements retain their original semantics. */
export function syncedSettingsPatches(patches: readonly AppSettingsPatch[]): AppSettingsPatch[] {
  const result: AppSettingsPatch[] = [];
  for (const patch of patches) {
    const mixedAncestor =
      patch.path[0] === "app" &&
      patch.path.length === 2 &&
      ["paseoPlusPlus", "usage"].includes(patch.path[1]!);
    if (mixedAncestor && isSettingsObject(patch.value)) {
      for (const [key, value] of Object.entries(patch.value)) {
        const path = [...patch.path, key];
        if (isSyncedSettingsPath(path)) result.push({ ...patch, path, value });
      }
    } else if (isSyncedSettingsPath(patch.path)) result.push(patch);
  }
  return result;
}

/** Backups retain device choices; explicit publication excludes them. */
export function exportSharedAppSettings(app: Record<string, unknown>): Record<string, unknown> {
  const shared = { ...app };
  for (const key of DEVICE_LOCAL_APP_SETTING_KEYS) delete shared[key];
  if (isSettingsObject(shared.paseoPlusPlus)) {
    const fork = { ...shared.paseoPlusPlus };
    for (const key of DEVICE_LOCAL_FORK_SETTING_KEYS) delete fork[key];
    shared.paseoPlusPlus = fork;
  }
  return shared;
}
