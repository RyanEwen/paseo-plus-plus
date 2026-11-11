import { beforeAll, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n/i18next";
import {
  VALID_SHA256,
  buildAndroidUpdate,
  createFakeAndroidUpdater,
} from "./test-utils/fake-android-updater";
import {
  AUTOMATIC_CHECK_MIN_GAP_MS,
  createAndroidUpdater,
  isAndroidUpdateBusy,
  isAndroidUpdateTransferring,
} from "./store";

const update = buildAndroidUpdate(14);
const manual = { intent: "manual" } as const;
const automatic = { intent: "automatic" } as const;

describe("Android update operation", () => {
  it("publishes measured download progress and verification without stale updates after installation", async () => {
    const { updater, native, releases } = createFakeAndroidUpdater();
    await updater.getState().check(manual);
    native.holdDownloads = true;
    const pending = updater.getState().install();
    await vi.waitFor(() => expect(native.downloads).toHaveLength(1));
    const progress = {
      versionCode: update.versionCode,
      phase: "downloading" as const,
      bytesDownloaded: 8 * 1024 * 1024,
      totalBytes: 32 * 1024 * 1024,
    };
    native.emitProgress({ ...progress, versionCode: update.versionCode - 1 });
    expect(updater.getState().progress).toBeNull();
    native.emitProgress(progress);
    expect(updater.getState()).toMatchObject({ status: "downloading", progress });
    native.emitProgress({ ...progress, phase: "verifying", bytesDownloaded: progress.totalBytes });
    expect(updater.getState().status).toBe("verifying");
    await updater.getState().check(automatic);
    await updater.getState().install();
    expect(native.downloads).toHaveLength(1);
    expect(releases.finds).toBe(1);
    native.finishDownloads();
    await pending;
    expect(updater.getState()).toMatchObject({ status: "installer", progress: null });
    expect(native.listenerCount).toBe(0);
    expect(native.removedListeners).toBe(1);
  });

  it("retains a verified download across the permission prompt and cancelled installation", async () => {
    const { updater, native, releases } = createFakeAndroidUpdater();
    await updater.getState().check(manual);
    native.installResults = ["permission_required"];
    await updater.getState().install();
    expect(updater.getState()).toMatchObject({
      status: "permission",
      preparedVersionCode: update.versionCode,
    });
    await updater.getState().check(automatic);
    expect(releases.finds).toBe(1);
    await updater.getState().install();
    expect(updater.getState().status).toBe("installer");
    await updater.getState().install();
    expect(native.downloads).toEqual([
      { url: update.url, sha256: VALID_SHA256, versionCode: update.versionCode },
    ]);
    expect(native.installs).toEqual([update.versionCode, update.versionCode, update.versionCode]);
  });

  it("keeps failed downloads actionable and downloads again on retry", async () => {
    const { updater, native } = createFakeAndroidUpdater();
    await updater.getState().check(manual);
    native.downloadFailures = [new Error("Update checksum mismatch")];
    await updater.getState().install();
    expect(updater.getState()).toMatchObject({
      status: "error",
      error: "Update checksum mismatch",
      update,
      preparedVersionCode: null,
    });
    expect(native.installs).toEqual([]);
    await updater.getState().install();
    expect(updater.getState()).toMatchObject({ status: "installer", error: null });
    expect(native.downloads).toHaveLength(2);
  });

  it("never invokes the native installer without a valid checksum", async () => {
    const { updater, native, releases } = createFakeAndroidUpdater();
    await updater.getState().check(manual);
    releases.checksum = new Error("Invalid APK checksum inventory");
    await updater.getState().install();
    expect(updater.getState()).toMatchObject({
      status: "error",
      error: "Invalid APK checksum inventory",
    });
    expect(native.downloads).toEqual([]);
    expect(native.installs).toEqual([]);
  });

  it("prevents overlapping downloads and checks", async () => {
    const { updater, native, releases } = createFakeAndroidUpdater();
    await updater.getState().check(manual);
    native.holdDownloads = true;
    const pending = updater.getState().install();
    await vi.waitFor(() => expect(native.downloads).toHaveLength(1));
    await updater.getState().install();
    await updater.getState().check(manual);
    expect(releases.finds).toBe(1);
    native.finishDownloads();
    await pending;
    expect(native.installs).toHaveLength(1);
  });

  it("reports manual check errors and keeps background checks quiet", async () => {
    const { updater, releases, clock } = createFakeAndroidUpdater();
    await updater.getState().check(manual);
    releases.next = new Error("Offline");
    clock.advance(AUTOMATIC_CHECK_MIN_GAP_MS);
    await updater.getState().check(automatic);
    expect(releases.finds).toBe(2);
    expect(updater.getState()).toMatchObject({ status: "available", error: null, update });
    await updater.getState().check(manual);
    expect(updater.getState()).toMatchObject({ status: "error", error: "Offline", update });
  });

  it("leaves pending permission, installer and error states to the user on automatic checks", async () => {
    const { updater, releases } = createFakeAndroidUpdater();
    for (const status of ["permission", "installer", "error"] as const) {
      updater.setState({ status });
      await updater.getState().check(automatic);
      expect(updater.getState().status).toBe(status);
    }
    expect(releases.finds).toBe(0);
    await updater.getState().check(manual);
    expect(releases.finds).toBe(1);
  });

  it("reports the latest preview when the installed build is current", async () => {
    const { updater, releases } = createFakeAndroidUpdater();
    releases.next = null;
    await updater.getState().check(manual);
    expect(updater.getState()).toMatchObject({ status: "current", update: null });
  });

  it("reports installer launch errors and permits a fresh retry", async () => {
    const { updater, native } = createFakeAndroidUpdater();
    await updater.getState().check(manual);
    native.installResults = [new Error("Installer unavailable")];
    await updater.getState().install();
    expect(updater.getState()).toMatchObject({ status: "error", error: "Installer unavailable" });
    await updater.getState().install();
    expect(updater.getState().status).toBe("installer");
  });

  it("does nothing in builds without the native updater", async () => {
    const { releases } = createFakeAndroidUpdater();
    const updater = createAndroidUpdater({ native: null, releases, now: () => 0 });
    expect(updater.getState().available).toBe(false);
    await updater.getState().check(manual);
    updater.setState({ update });
    await updater.getState().install();
    expect(updater.getState().status).toBe("idle");
    expect(releases.finds).toBe(0);
  });
});

describe("Android native update failures", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  it("shows translated copy for a coded native rejection", async () => {
    const { updater, native } = createFakeAndroidUpdater();
    await updater.getState().check(manual);
    native.downloadFailures = [
      Object.assign(new Error("Call to function has been rejected."), {
        code: "ERR_UPDATE_CHECKSUM_MISMATCH",
      }),
    ];
    await updater.getState().install();
    expect(updater.getState()).toMatchObject({
      status: "error",
      error: "Update checksum mismatch. Try downloading again.",
    });
  });
});

describe("Android automatic check budget", () => {
  it("skips automatic checks within the minimum gap, counting failed ones", async () => {
    const { updater, releases, clock } = createFakeAndroidUpdater();
    releases.next = null;
    await updater.getState().check(automatic);
    expect(updater.getState().lastCheckedAt).toBe(clock.time);
    clock.advance(AUTOMATIC_CHECK_MIN_GAP_MS - 1);
    await updater.getState().check(automatic);
    expect(releases.finds).toBe(1);
    clock.advance(1);
    releases.next = new Error("Offline");
    await updater.getState().check(automatic);
    expect(releases.finds).toBe(2);
    clock.advance(AUTOMATIC_CHECK_MIN_GAP_MS - 1);
    await updater.getState().check(automatic);
    expect(releases.finds).toBe(2);
  });

  it("always runs manual checks and starts the gap from them", async () => {
    const { updater, releases, clock } = createFakeAndroidUpdater();
    releases.next = null;
    await updater.getState().check(manual);
    await updater.getState().check(manual);
    expect(releases.finds).toBe(2);
    clock.advance(AUTOMATIC_CHECK_MIN_GAP_MS - 1);
    await updater.getState().check(automatic);
    expect(releases.finds).toBe(2);
  });
});

describe("Android update status predicates", () => {
  it.each([
    ["idle", false, false],
    ["checking", true, false],
    ["current", false, false],
    ["available", false, false],
    ["downloading", true, true],
    ["verifying", true, true],
    ["permission", false, false],
    ["installer", false, false],
    ["error", false, false],
  ] as const)("%s: busy=%s transferring=%s", (status, busy, transferring) => {
    expect(isAndroidUpdateBusy(status)).toBe(busy);
    expect(isAndroidUpdateTransferring(status)).toBe(transferring);
  });
});
