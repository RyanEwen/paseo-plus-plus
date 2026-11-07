import type {
  AppSettingsPatch,
  AppSettingsPatchResult,
  AppSettingsSnapshot,
} from "@getpaseo/protocol/app-settings";
import {
  cloneSettingsJson,
  settingsFieldKey,
  settingsPathRevision,
  settingsValueAtPath,
} from "@getpaseo/protocol/app-settings-values";

/**
 * Pure list transforms for a host's pending settings edits. The sync model owns fencing,
 * persistence and status; these functions only compute the next pending list.
 */

/**
 * Add new edits to a host's pending list. A later edit of the same leaf replaces its value but
 * keeps the revision the first edit expected, so the host still detects concurrent changes.
 */
export function mergePending(
  pending: readonly AppSettingsPatch[],
  patches: readonly AppSettingsPatch[],
): AppSettingsPatch[] {
  const merged = new Map(pending.map((patch) => [settingsFieldKey(patch.path), patch]));
  for (const patch of patches) {
    const key = settingsFieldKey(patch.path);
    const previous = merged.get(key);
    merged.set(key, {
      ...patch,
      expectedRevision: previous?.expectedRevision ?? patch.expectedRevision,
    });
  }
  return [...merged.values()];
}

/** Drop edits the host already stores, such as a write whose outcome was unknown. */
export function dropAlreadyDurable(
  pending: readonly AppSettingsPatch[],
  snapshot: AppSettingsSnapshot,
): AppSettingsPatch[] {
  return pending.filter(
    (patch) =>
      JSON.stringify(settingsValueAtPath(snapshot.values, patch.path)) !==
      JSON.stringify(patch.value),
  );
}

/** Keep every edit's value but expect the host's current revision, overriding its changes. */
export function rebaseOnto(
  pending: readonly AppSettingsPatch[],
  snapshot: AppSettingsSnapshot,
): AppSettingsPatch[] {
  return pending.map((patch) => ({
    path: patch.path,
    value: patch.value,
    expectedRevision: settingsPathRevision(snapshot, patch.path),
  }));
}

/**
 * Settle a successful write. Edits sent unchanged are acknowledged and removed; a leaf edited
 * again while the write was in flight stays pending, now expecting the revision just written.
 * A write with conflicts changes nothing.
 */
export function dropAcknowledged(
  pending: readonly AppSettingsPatch[],
  sent: readonly AppSettingsPatch[],
  result: AppSettingsPatchResult,
): AppSettingsPatch[] {
  const next = cloneSettingsJson([...pending]);
  if (result.conflicts.length) return next;

  const acknowledged = new Set(sent.map((patch) => JSON.stringify(patch)));
  const sentKeys = new Set(sent.map((patch) => settingsFieldKey(patch.path)));
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const patch = next[index]!;
    if (acknowledged.has(JSON.stringify(patch))) {
      next.splice(index, 1);
    } else if (sentKeys.has(settingsFieldKey(patch.path))) {
      patch.expectedRevision = settingsPathRevision(result.snapshot, patch.path);
    }
  }
  return next;
}
