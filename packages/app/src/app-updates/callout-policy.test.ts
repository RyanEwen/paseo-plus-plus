import { describe, expect, it } from "vitest";
import "@/i18n/i18next"; // registers the update copy resources
import {
  AUTOMATIC_CHECK_INTERVAL_MS,
  resolveAndroidUpdateCallout,
  shouldRunAutomaticChecks,
  startAutomaticChecks,
} from "./callout-policy";
import type { AndroidUpdateState } from "./store";
import { buildAndroidUpdate } from "./test-utils/fake-android-updater";

const update = buildAndroidUpdate(14);

type CalloutInput = Pick<
  AndroidUpdateState,
  "available" | "status" | "update" | "error" | "progress"
>;

function calloutFor(input: Partial<CalloutInput>) {
  return resolveAndroidUpdateCallout({
    available: true,
    status: "idle",
    update: null,
    error: null,
    progress: null,
    ...input,
  });
}

/** Manual interval clock: records the scheduled period and fires ticks on demand. */
function manualInterval() {
  const clock = { periodMs: 0, tick: () => {}, cancelled: false };
  const every = (periodMs: number, tick: () => void) => {
    clock.periodMs = periodMs;
    clock.tick = tick;
    return () => {
      clock.cancelled = true;
    };
  };
  return { clock, every };
}

describe("automatic Android update checks", () => {
  const allowed = { available: true, settingsLoading: false, settingsError: null, enabled: true };

  it("wait for saved settings, honour the opt-out and stop when settings failed to load", () => {
    expect(shouldRunAutomaticChecks(allowed)).toBe(true);
    expect(shouldRunAutomaticChecks({ ...allowed, settingsLoading: true })).toBe(false);
    expect(shouldRunAutomaticChecks({ ...allowed, enabled: false })).toBe(false);
    expect(
      shouldRunAutomaticChecks({ ...allowed, settingsError: new Error("Unable to read settings") }),
    ).toBe(false);
    expect(shouldRunAutomaticChecks({ ...allowed, available: false })).toBe(false);
  });

  it("check at start, then every interval only while the app is actively visible", () => {
    const { clock, every } = manualInterval();
    let checks = 0;
    let active = true;
    const stop = startAutomaticChecks({
      check: () => (checks += 1),
      isActive: () => active,
      every,
    });
    expect(checks).toBe(1);
    expect(clock.periodMs).toBe(AUTOMATIC_CHECK_INTERVAL_MS);
    clock.tick();
    expect(checks).toBe(2);
    active = false;
    clock.tick();
    expect(checks).toBe(2);
    stop();
    expect(clock.cancelled).toBe(true);
  });
});

describe("Android update callout", () => {
  it("stays hidden without the updater, before any result, and while checking", () => {
    expect(calloutFor({ available: false, status: "available", update })).toBeNull();
    expect(calloutFor({ status: "idle" })).toBeNull();
    expect(calloutFor({ status: "current" })).toBeNull();
    expect(calloutFor({ status: "checking", update })).toBeNull();
  });

  it("offers installation of an available preview", () => {
    expect(calloutFor({ status: "available", update })).toEqual({
      id: "android-app-update",
      dismissalKey: "android-app-update:0.11.1-preview.14:available",
      priority: 200,
      titleKey: "desktop.updates.callout.availableTitle",
      description: "Preview 0.11.1-preview.14 is available.",
      variant: "default",
      action: { role: "install", labelKey: "androidUpdates.install", disabled: false },
      testID: "android-update-callout",
    });
  });

  it("disables installation while the APK downloads or verifies", () => {
    for (const status of ["downloading", "verifying"] as const) {
      expect(calloutFor({ status, update })).toMatchObject({
        titleKey: "androidUpdates.title",
        dismissalKey: `android-app-update:0.11.1-preview.14:${status}`,
        action: { role: "install", disabled: true },
      });
    }
  });

  it("keeps install as the action after a failed installation", () => {
    expect(
      calloutFor({ status: "error", update, error: "Update checksum mismatch" }),
    ).toMatchObject({
      variant: "error",
      description: "Update checksum mismatch",
      action: { role: "install", disabled: false },
    });
  });

  it("offers a retry when a check failed before anything was found", () => {
    expect(calloutFor({ status: "error", error: "Offline" })).toMatchObject({
      dismissalKey: "android-app-update:error:error",
      variant: "error",
      action: { role: "retry", labelKey: "common.actions.retry", disabled: false },
    });
  });
});
