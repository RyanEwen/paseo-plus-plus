import type { SyncStatus } from "./model";

/** What the current settings sync status allows. One table instead of status lists per caller. */
export interface SyncStatusPolicy {
  /** Settings may be saved now: on this device alone, or through a host adopted for writing. */
  allowsEdits: boolean;
  /** The values on screen come from a successful read of the current settings authority. */
  hasReadableValues: boolean;
  /** The device backup taken before adopting the selected host can be restored. */
  canRestoreBackup: boolean;
  /** Retry re-reads the current settings authority. */
  canRetry: boolean;
}

const NONE: SyncStatusPolicy = {
  allowsEdits: false,
  hasReadableValues: false,
  canRestoreBackup: false,
  canRetry: false,
};

export const SYNC_STATUS_POLICY: Record<SyncStatus, SyncStatusPolicy> = {
  loading: NONE,
  local: { ...NONE, allowsEdits: true, hasReadableValues: true },
  reading: NONE,
  ready: { ...NONE, allowsEdits: true, hasReadableValues: true, canRestoreBackup: true },
  offline: { ...NONE, allowsEdits: true, hasReadableValues: true, canRestoreBackup: true },
  empty: NONE,
  unsupported: NONE,
  error: { ...NONE, canRetry: true },
  conflict: { ...NONE, hasReadableValues: true, canRestoreBackup: true },
  readonly: { ...NONE, hasReadableValues: true, canRestoreBackup: true, canRetry: true },
};
