import type { AppSettings } from "@/hooks/use-settings/storage";
import type { SettingsSyncModel } from "./model";

/**
 * Settings sync domain adapters.
 *
 * Settings sync owns plain app preferences. A feature that keeps synced state elsewhere (its own
 * store, or a host-capability filter on publication) registers an adapter here instead of the
 * sync runtime importing feature code. The registry is domain-neutral: it only orders and
 * invokes adapters, and every policy stays in the registering feature.
 */

/** What the sync runtime is preparing device values for. */
export interface SettingsSyncContext {
  /** "backup" keeps every choice for local restore; "publish" sends values to the selected host. */
  purpose: "backup" | "publish";
  /** The selected settings host, or null while settings stay on this device. */
  selectedHost: string | null;
}

/** One feature's contribution to settings sync. Every hook is optional. */
export interface SettingsSyncDomain {
  /**
   * Stable adapter id. When the adapter supplies device values they are stored under this
   * top-level key, so it must match a wire domain the daemon accepts (for example "sidebar").
   * "app" is reserved for plain app preferences.
   */
  id: string;
  /** App preference keys this adapter projects itself; the plain app export leaves them out. */
  ownedAppKeys?: readonly string[];
  /** Load local state before sync reads or replaces it. Rejecting keeps editing blocked. */
  initialize?(): Promise<void>;
  /** Device values for this domain, read for both backups and publication. */
  readDeviceValues?(context: SettingsSyncContext): Promise<unknown> | unknown;
  /** Publication only: adjust the shared app export, e.g. omit a field the host rejects. */
  filterAppExport?(
    app: Record<string, unknown>,
    context: SettingsSyncContext,
  ): Record<string, unknown>;
  /** Project adopted host values. Runs after the app preferences are durably saved. */
  applyValues?(values: Record<string, unknown>, app: AppSettings): Promise<void> | void;
  /** Start committing this domain's local edits through the sync model; return a stop function. */
  observeEdits?(sync: SettingsSyncModel): () => void;
}

const RESERVED_DOMAIN_IDS = new Set(["app"]);
const domains = new Map<string, SettingsSyncDomain>();
const listeners = new Set<() => void>();

/**
 * Register a feature adapter from an effect or startup hook, never at module import: Fast Refresh
 * re-runs modules, and a second registration of the same id throws. Mount the registering
 * component before <SettingsSyncBootstrap /> so its initialize() runs before the first load;
 * edit observers follow registrations made at any time.
 *
 * Returns an unregister function. Throws for a duplicate or reserved id, so two features cannot
 * silently write the same domain.
 */
export function registerSettingsSyncDomain(domain: SettingsSyncDomain): () => void {
  if (RESERVED_DOMAIN_IDS.has(domain.id)) {
    throw new Error(`Settings sync domain "${domain.id}" is reserved`);
  }
  if (domains.has(domain.id)) {
    throw new Error(`Settings sync domain "${domain.id}" is already registered`);
  }
  domains.set(domain.id, domain);
  notifyRegistration();
  return () => {
    if (domains.get(domain.id) !== domain) return;
    domains.delete(domain.id);
    notifyRegistration();
  };
}

/** Registered adapters in registration order. */
export function listSettingsSyncDomains(): readonly SettingsSyncDomain[] {
  return [...domains.values()];
}

/** Notify the listener after every registration or removal; return an unsubscribe function. */
export function subscribeSettingsSyncDomains(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notifyRegistration(): void {
  for (const listener of listeners) listener();
}

/** Initialize adapters one at a time; the first rejection stops and propagates. */
export async function initializeDomains(list: readonly SettingsSyncDomain[]): Promise<void> {
  for (const domain of list) {
    await domain.initialize?.();
  }
}

/** Every app key some adapter projects itself. */
export function ownedDomainAppKeys(list: readonly SettingsSyncDomain[]): Set<string> {
  return new Set(list.flatMap((domain) => domain.ownedAppKeys ?? []));
}

/** Read each adapter's device values, keyed by adapter id. */
export async function collectDomainDeviceValues(
  list: readonly SettingsSyncDomain[],
  context: SettingsSyncContext,
): Promise<Record<string, unknown>> {
  const values: Record<string, unknown> = {};
  for (const domain of list) {
    if (domain.readDeviceValues) {
      values[domain.id] = await domain.readDeviceValues(context);
    }
  }
  return values;
}

/** Apply publication filters in registration order. */
export function filterDomainAppExport(
  list: readonly SettingsSyncDomain[],
  app: Record<string, unknown>,
  context: SettingsSyncContext,
): Record<string, unknown> {
  let result = app;
  for (const domain of list) {
    if (domain.filterAppExport) {
      result = domain.filterAppExport(result, context);
    }
  }
  return result;
}

/** Project adopted host values through each adapter, in registration order. */
export async function applyDomainValues(
  list: readonly SettingsSyncDomain[],
  values: Record<string, unknown>,
  app: AppSettings,
): Promise<void> {
  for (const domain of list) {
    await domain.applyValues?.(values, app);
  }
}

/**
 * Keep one edit observer per registered adapter while the sync owner runs, following adapters
 * registered or removed later. The returned function stops every observer it started, newest
 * first. If an install throws, the error propagates to whoever triggered the change.
 */
export function trackDomainEdits(sync: SettingsSyncModel): () => void {
  const active = new Map<SettingsSyncDomain, () => void>();

  const reconcile = () => {
    const current = new Set(listSettingsSyncDomains());
    for (const [domain, stop] of active) {
      if (current.has(domain)) continue;
      active.delete(domain);
      stop();
    }
    for (const domain of current) {
      if (!domain.observeEdits || active.has(domain)) continue;
      active.set(domain, domain.observeEdits(sync));
    }
  };

  const stopAll = () => {
    const stops = [...active.values()].toReversed();
    active.clear();
    for (const stop of stops) stop();
  };

  try {
    reconcile();
  } catch (error) {
    stopAll();
    throw error;
  }
  const unsubscribe = subscribeSettingsSyncDomains(reconcile);
  return () => {
    unsubscribe();
    stopAll();
  };
}
