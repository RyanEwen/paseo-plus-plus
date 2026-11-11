import type { AppSettingsUpdate } from "@/hooks/use-settings/storage";
import type { QueryClient } from "@tanstack/react-query";
import type { SyncStatus } from "./model";
import { SYNC_STATUS_POLICY } from "./status-policy";

/** Saves through settings sync; resolves false to keep the ordinary local storage path. */
export type SettingsSyncSaveHandler = (
  queryClient: QueryClient,
  updates: AppSettingsUpdate,
) => Promise<boolean>;

/** What app settings consumers need from the running settings sync owner. */
export interface SettingsSyncGateState {
  /** The installed save handler, or null when no settings sync owner is running. */
  saveHandler: SettingsSyncSaveHandler | null;
  /** Settings controls must wait: the selected host is loading or refuses writes. */
  editingBlocked: boolean;
  /** The current settings authority has successfully supplied readable values. */
  readAvailable: boolean;
}

/** One installation of the save handler, owned by the app-wide settings sync owner. */
export interface SettingsSyncGateInstallation {
  /** Whether this installation still owns the gate. */
  isCurrent(): boolean;
  /**
   * Publish read availability for a sync generation. Only the current installation can publish,
   * an older generation is ignored, and a new authority read revokes earlier evidence.
   */
  updateReadAvailability(input: {
    hydrated: boolean;
    generation: number;
    status: SyncStatus;
  }): void;
  /** Remove the handler and clear the gate, unless a newer installation replaced this one. */
  release(): void;
}

const INITIAL: SettingsSyncGateState = {
  saveHandler: null,
  editingBlocked: false,
  readAvailable: false,
};

/** The settings sync gate: the save handler and the editing and read state it publishes. */
export class SettingsSyncGate {
  private state = INITIAL;
  private owner: object | null = null;
  private readonly listeners = new Set<() => void>();

  getState = (): SettingsSyncGateState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Install the save handler. A later installation replaces this one. */
  install(saveHandler: SettingsSyncSaveHandler): SettingsSyncGateInstallation {
    const owner = {};
    this.owner = owner;
    this.publish({ saveHandler, readAvailable: false });
    let successfulReadGeneration: number | null = null;
    let latestGeneration = -1;
    const isCurrent = () => this.owner === owner;

    return {
      isCurrent,
      updateReadAvailability: (input) => {
        if (!isCurrent() || input.generation < latestGeneration) return;
        latestGeneration = input.generation;
        if (!input.hydrated) {
          successfulReadGeneration = null;
        } else if (SYNC_STATUS_POLICY[input.status].hasReadableValues) {
          successfulReadGeneration = input.generation;
        } else if (input.status !== "error" || successfulReadGeneration !== input.generation) {
          successfulReadGeneration = null;
        }
        // A failed save retains a known read; a failed initial/read-generation never invents one.
        const readable = input.hydrated && successfulReadGeneration === input.generation;
        this.publish({ readAvailable: readable });
      },
      release: () => {
        if (!isCurrent()) return;
        this.owner = null;
        this.publish({ saveHandler: null, readAvailable: false, editingBlocked: false });
      },
    };
  }

  /** Settings controls share the same adoption gate as writes, including non-Settings callers. */
  setEditingBlocked(editingBlocked: boolean): void {
    this.publish({ editingBlocked });
  }

  /** Replace changed fields and notify only when something changed. */
  private publish(patch: Partial<SettingsSyncGateState>): void {
    const next = { ...this.state, ...patch };
    const changed =
      next.saveHandler !== this.state.saveHandler ||
      next.editingBlocked !== this.state.editingBlocked ||
      next.readAvailable !== this.state.readAvailable;
    if (!changed) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}

export const settingsSyncGate = new SettingsSyncGate();
