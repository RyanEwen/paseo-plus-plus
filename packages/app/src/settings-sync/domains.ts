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

/**
 * Register a feature adapter. Call it at module load, before the settings sync bootstrap mounts:
 * edit observers install when the bootstrap starts, so a later registration misses them.
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
  return () => {
    if (domains.get(domain.id) === domain) domains.delete(domain.id);
  };
}

/** Registered adapters in registration order. */
export function listSettingsSyncDomains(): readonly SettingsSyncDomain[] {
  return [...domains.values()];
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
 * Install every adapter's edit observer. Returns one stop function that stops them in reverse
 * order. If an install throws, observers installed so far are stopped before rethrowing.
 */
export function observeDomainEdits(
  list: readonly SettingsSyncDomain[],
  sync: SettingsSyncModel,
): () => void {
  const stops: (() => void)[] = [];
  const stopAll = () => {
    for (const stop of stops.splice(0).reverse()) stop();
  };

  try {
    for (const domain of list) {
      if (domain.observeEdits) stops.push(domain.observeEdits(sync));
    }
  } catch (error) {
    stopAll();
    throw error;
  }
  return stopAll;
}
