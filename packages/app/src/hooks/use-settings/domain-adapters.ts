import { useEffect } from "react";
import { createStore } from "zustand/vanilla";
import type { AppSettings } from "./storage";

/**
 * Settings domain adapter registry.
 *
 * A consumer that exchanges app settings with another store (for example a settings host) owns
 * the plain app preferences. A feature with related state elsewhere, such as its own store or a
 * capability-dependent field, registers an adapter here instead of that consumer importing the
 * feature. This module only stores adapters and reports changes; the consumer decides when to
 * call each hook, and each feature keeps its own policy.
 */

/** Why the consumer is reading device values. */
export interface SettingsDomainContext {
  /** "backup" keeps every choice for a local restore; "publish" sends values to another store. */
  purpose: "backup" | "publish";
  /** The selected destination, or null while settings stay on this device. */
  selectedHost: string | null;
}

/** One feature's contribution to exchanged settings. Every hook is optional. */
export interface SettingsDomainAdapter {
  /**
   * Stable adapter id. Device values the adapter supplies are stored under this top-level key,
   * so it must name a domain the destination accepts. "app" is reserved for plain app preferences.
   */
  id: string;
  /** App preference keys this adapter projects itself; the plain app export leaves them out. */
  ownedAppKeys?: readonly string[];
  /** Load local state before the consumer reads or replaces it. Rejecting keeps edits blocked. */
  initialize?(): Promise<void>;
  /** Device values for this domain, read for both backups and publication. */
  readDeviceValues?(context: SettingsDomainContext): Promise<unknown> | unknown;
  /** Publication only: adjust the shared app export, e.g. omit a field the destination rejects. */
  filterAppExport?(
    app: Record<string, unknown>,
    context: SettingsDomainContext,
  ): Record<string, unknown>;
  /** Project adopted values. Runs after the app preferences are durably saved. */
  applyValues?(values: Record<string, unknown>, app: AppSettings): Promise<void> | void;
  /** Start committing this domain's local edits; return a stop function. */
  observeEdits?(): () => void;
}

const RESERVED_ADAPTER_IDS = new Set(["app"]);
/** Adapters by id in registration order. Each change replaces the map. */
const registry = createStore<{ adapters: ReadonlyMap<string, SettingsDomainAdapter> }>(() => ({
  adapters: new Map(),
}));

/**
 * Register an adapter. Call it from an effect or startup hook, never at module import: Fast
 * Refresh re-runs modules, and a second registration of the same id throws. Register before the
 * consumer's first load when initialize() must run first; consumers follow later registrations
 * through subscribeSettingsDomainAdapters.
 *
 * Returns an unregister function. Throws for a duplicate or reserved id, so two features cannot
 * silently write the same domain.
 */
export function registerSettingsDomainAdapter(adapter: SettingsDomainAdapter): () => void {
  if (RESERVED_ADAPTER_IDS.has(adapter.id)) {
    throw new Error(`Settings domain adapter id "${adapter.id}" is reserved`);
  }
  if (registry.getState().adapters.has(adapter.id)) {
    throw new Error(`Settings domain adapter "${adapter.id}" is already registered`);
  }
  const added = new Map(registry.getState().adapters);
  added.set(adapter.id, adapter);
  registry.setState({ adapters: added });
  return () => {
    const current = registry.getState().adapters;
    if (current.get(adapter.id) !== adapter) return;
    const remaining = new Map(current);
    remaining.delete(adapter.id);
    registry.setState({ adapters: remaining });
  };
}

/** Registered adapters in registration order. */
export function listSettingsDomainAdapters(): readonly SettingsDomainAdapter[] {
  return [...registry.getState().adapters.values()];
}

/** Notify the listener after every registration or removal; return an unsubscribe function. */
export function subscribeSettingsDomainAdapters(listener: () => void): () => void {
  return registry.subscribe(() => listener());
}

/**
 * Register `adapter` while the calling component is mounted. Pass a stable object (for example a
 * module-level constant); a new object on every render re-registers it each time.
 */
export function useSettingsDomainAdapter(adapter: SettingsDomainAdapter): void {
  useEffect(() => registerSettingsDomainAdapter(adapter), [adapter]);
}
