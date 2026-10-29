import type { AppSettingsUpdate } from "@/hooks/use-settings/storage";
import type { QueryClient } from "@tanstack/react-query";
import type { SyncStatus } from "./model";

let handler: ((queryClient: QueryClient, updates: AppSettingsUpdate) => Promise<boolean>) | null =
  null;
let editingBlocked = false;
let currentOwner: object | null = null;
let readAvailable = false;
const readListeners = new Set<() => void>();
const listeners = new Set<() => void>();

/** Installed once by app bootstrap; return false to retain the ordinary local storage path. */
export function installSettingsSyncSaveHandler(next: typeof handler) {
  const owner = {};
  currentOwner = owner;
  handler = next;
  publishSettingsReadAvailable(false);
  let successfulReadGeneration: number | null = null;
  let latestGeneration = -1;
  const isCurrent = () => currentOwner === owner;
  const uninstall = () => {
    if (!isCurrent()) return;
    currentOwner = null;
    handler = null;
    publishSettingsReadAvailable(false);
    setSettingsEditingBlocked(false);
  };
  return Object.assign(uninstall, {
    isCurrent,
    /** Only this installation can publish readiness; a new authority read revokes prior evidence. */
    updateReadAvailability(input: {
      hydrated: boolean;
      generation: number;
      status: SyncStatus;
    }): void {
      if (!isCurrent() || input.generation < latestGeneration) return;
      latestGeneration = input.generation;
      if (!input.hydrated) {
        successfulReadGeneration = null;
      } else if (["local", "ready", "readonly", "offline", "conflict"].includes(input.status)) {
        successfulReadGeneration = input.generation;
      } else if (input.status !== "error" || successfulReadGeneration !== input.generation) {
        successfulReadGeneration = null;
      }
      // A failed save retains a known read; a failed initial/read-generation never invents one.
      publishSettingsReadAvailable(input.hydrated && successfulReadGeneration === input.generation);
    },
  });
}

/** Read availability is independent of write permissions and has the same bootstrap owner. */
function publishSettingsReadAvailable(value: boolean): void {
  if (readAvailable === value) return;
  readAvailable = value;
  for (const listener of readListeners) listener();
}
export function getSettingsReadAvailable(): boolean {
  return readAvailable;
}
export function subscribeSettingsReadAvailable(listener: () => void): () => void {
  readListeners.add(listener);
  return () => {
    readListeners.delete(listener);
  };
}

export function getSettingsSyncSaveHandler(): typeof handler {
  return handler;
}

/** Settings controls share the same adoption gate as writes, including non-Settings callers. */
export function setSettingsEditingBlocked(value: boolean): void {
  if (editingBlocked === value) return;
  editingBlocked = value;
  for (const listener of listeners) listener();
}
export function getSettingsEditingBlocked(): boolean {
  return editingBlocked;
}
export function subscribeSettingsEditingBlocked(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

let hostSelected = false;
/** Automatic sidebar reconciliation must not prune preferences owned by another client. */
export function setSettingsHostSelected(value: boolean): void {
  hostSelected = value;
}
export function getSettingsHostSelected(): boolean {
  return hostSelected;
}
