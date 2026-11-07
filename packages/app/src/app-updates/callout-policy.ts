import { isAndroidUpdateTransferring, type AndroidUpdateState } from "./store";
import { describeAndroidUpdate } from "./status";

/** How often an open, visible app checks for a newer preview. */
export const AUTOMATIC_CHECK_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Automatic checks need the native updater and the user's saved preference. Wait until settings
 * have loaded without error, so a persisted opt-out is never overtaken by a startup request.
 */
export function shouldRunAutomaticChecks(input: {
  available: boolean;
  settingsLoading: boolean;
  settingsError: Error | null;
  enabled: boolean;
}): boolean {
  return input.available && !input.settingsLoading && input.settingsError === null && input.enabled;
}

/**
 * Check now, then on every interval tick while the app is actively visible.
 * Returns a function that stops the interval.
 */
export function startAutomaticChecks({
  check,
  isActive,
  every = defaultEvery,
}: {
  check: () => void;
  isActive: () => boolean;
  /** Schedules a repeating tick and returns its cancel function; injectable for tests. */
  every?: (intervalMs: number, tick: () => void) => () => void;
}): () => void {
  check();
  return every(AUTOMATIC_CHECK_INTERVAL_MS, () => {
    if (isActive()) check();
  });
}

function defaultEvery(intervalMs: number, tick: () => void): () => void {
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}

export type AndroidUpdateCalloutActionRole = "install" | "retry";

/** Everything the sidebar callout shows, with copy still as translation keys where static. */
export interface AndroidUpdateCalloutDescriptor {
  id: "android-app-update";
  dismissalKey: string;
  priority: number;
  titleKey: "desktop.updates.callout.availableTitle" | "androidUpdates.title";
  description: string;
  variant: "default" | "error";
  action: {
    role: AndroidUpdateCalloutActionRole;
    labelKey: "androidUpdates.install" | "common.actions.retry";
    disabled: boolean;
  };
  testID: "android-update-callout";
}

/**
 * The sidebar callout for the current update state, or null when there is nothing to offer:
 * no native updater, nothing found or failed yet, or a check still running.
 */
export function resolveAndroidUpdateCallout(
  state: Pick<AndroidUpdateState, "available" | "status" | "update" | "error" | "progress">,
): AndroidUpdateCalloutDescriptor | null {
  const { available, status, update, error, progress } = state;
  if (!available || (!update && !error) || status === "checking") return null;
  return {
    id: "android-app-update",
    // A new version or a new status brings back a callout the user dismissed earlier.
    dismissalKey: `android-app-update:${update?.version ?? "error"}:${status}`,
    priority: 200,
    titleKey:
      status === "available" ? "desktop.updates.callout.availableTitle" : "androidUpdates.title",
    description: describeAndroidUpdate({ status, update, error, progress }),
    variant: status === "error" ? "error" : "default",
    action: update
      ? {
          role: "install",
          labelKey: "androidUpdates.install",
          disabled: isAndroidUpdateTransferring(status),
        }
      : {
          role: "retry",
          labelKey: "common.actions.retry",
          disabled: isAndroidUpdateTransferring(status),
        },
    testID: "android-update-callout",
  };
}
