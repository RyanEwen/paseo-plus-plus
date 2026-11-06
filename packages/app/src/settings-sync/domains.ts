import {
  listSettingsDomainAdapters,
  subscribeSettingsDomainAdapters,
  type SettingsDomainAdapter,
  type SettingsDomainContext,
} from "@/hooks/use-settings/domain-adapters";
import type { AppSettings } from "@/hooks/use-settings/storage";

/**
 * How settings sync uses the fork-base settings domain adapter registry.
 *
 * Settings sync owns plain app preferences. Features with synced state elsewhere register an
 * adapter in the fork-base registry; these helpers decide the order in which sync calls each
 * adapter hook. Every feature policy stays in the registering feature.
 */

/** Initialize adapters one at a time; the first rejection stops and propagates. */
export async function initializeDomains(list: readonly SettingsDomainAdapter[]): Promise<void> {
  for (const domain of list) {
    await domain.initialize?.();
  }
}

/** Every app key some adapter projects itself. */
export function ownedDomainAppKeys(list: readonly SettingsDomainAdapter[]): Set<string> {
  return new Set(list.flatMap((domain) => domain.ownedAppKeys ?? []));
}

/** Read each adapter's device values, keyed by adapter id. */
export async function collectDomainDeviceValues(
  list: readonly SettingsDomainAdapter[],
  context: SettingsDomainContext,
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
  list: readonly SettingsDomainAdapter[],
  app: Record<string, unknown>,
  context: SettingsDomainContext,
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
  list: readonly SettingsDomainAdapter[],
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
export function trackDomainEdits(): () => void {
  const active = new Map<SettingsDomainAdapter, () => void>();

  const reconcile = () => {
    const current = new Set(listSettingsDomainAdapters());
    for (const [domain, stop] of active) {
      if (current.has(domain)) continue;
      active.delete(domain);
      stop();
    }
    for (const domain of current) {
      if (!domain.observeEdits || active.has(domain)) continue;
      active.set(domain, domain.observeEdits());
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
  const unsubscribe = subscribeSettingsDomainAdapters(reconcile);
  return () => {
    unsubscribe();
    stopAll();
  };
}
