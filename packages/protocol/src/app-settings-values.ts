import type { AppSettingsPatch, AppSettingsSnapshot } from "./app-settings.js";

/** The document of a host that has never stored settings. Clone it before mutating. */
export const EMPTY_APP_SETTINGS_SNAPSHOT: AppSettingsSnapshot = {
  initialized: false,
  revision: 0,
  values: {},
  fieldRevisions: {},
};

/** Keys that could reach an object prototype; never valid in a preference path. */
export const FORBIDDEN_SETTINGS_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

/** True when one path equals or contains the other, so writing one changes the other. */
export function settingsPathsOverlap(a: readonly string[], b: readonly string[]): boolean {
  return a.slice(0, Math.min(a.length, b.length)).every((part, index) => part === b[index]);
}

/** JSON-encoded paths avoid collisions with preference keys containing punctuation. */
export function settingsFieldKey(path: readonly string[]): string {
  return JSON.stringify(path);
}

/** Replacing an ancestor or descendant also changes this path's revision. */
export function settingsPathRevision(
  snapshot: AppSettingsSnapshot,
  path: readonly string[],
): number {
  let revision = 0;
  for (const [key, value] of Object.entries(snapshot.fieldRevisions)) {
    const other: string[] = JSON.parse(key);
    if (settingsPathsOverlap(other, path)) revision = Math.max(revision, value);
  }
  return revision;
}

/** Read one leaf without supplying client defaults for fields the host has never stored. */
export function settingsValueAtPath(
  values: Record<string, unknown>,
  path: readonly string[],
): unknown {
  return path.reduce<unknown>(
    (value, key) => (isSettingsObject(value) ? value[key] : undefined),
    values,
  );
}

export function isSettingsObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Compare user-edited values, descending into objects so unknown sibling keys stay intact. */
export function settingsDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  snapshot: AppSettingsSnapshot,
  prefix: string[] = [],
): AppSettingsPatch[] {
  const patches: AppSettingsPatch[] = [];
  for (const [key, value] of Object.entries(after)) {
    const path = [...prefix, key];
    const previous = before[key];
    if (isSettingsObject(value)) {
      patches.push(
        ...settingsDiff(isSettingsObject(previous) ? previous : {}, value, snapshot, path),
      );
    } else if (JSON.stringify(previous) !== JSON.stringify(value)) {
      patches.push({ path, value, expectedRevision: settingsPathRevision(snapshot, path) });
    }
  }
  return patches;
}

/** Overlay only explicit pending edits; never replace the host's entire document. */
export function applySettingsPatches(
  values: Record<string, unknown>,
  patches: readonly AppSettingsPatch[],
): Record<string, unknown> {
  const next = cloneSettingsJson(values);
  for (const patch of patches) {
    if (patch.path.some((key) => FORBIDDEN_SETTINGS_KEYS.has(key)))
      throw new Error("Unsafe preference path");
    let target = next;
    for (const key of patch.path.slice(0, -1)) {
      if (!isSettingsObject(target[key])) target[key] = {};
      target = target[key] as Record<string, unknown>;
    }
    target[patch.path.at(-1)!] = cloneSettingsJson(patch.value);
  }
  return next;
}

/** Settings documents contain JSON only. This clone also works in native JavaScript runtimes. */
export function cloneSettingsJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Usage host selection is device-local, including parent replacement that could carry it. */
export function isSyncedSettingsPath(path: readonly string[]): boolean {
  return !(
    path[0] === "app" &&
    path[1] === "usage" &&
    (path.length === 2 || path[2] === "serverId")
  );
}
