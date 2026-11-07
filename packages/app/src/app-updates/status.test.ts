import { describe, expect, it } from "vitest";
import "@/i18n/i18next"; // registers the update copy resources
import { describeAndroidUpdate, type AndroidUpdateDescriptionInput } from "./status";
import { buildAndroidUpdate } from "./test-utils/fake-android-updater";

const update = buildAndroidUpdate(14);

const progress = {
  versionCode: update.versionCode,
  phase: "downloading" as const,
  bytesDownloaded: 1024 * 1024,
  totalBytes: 4 * 1024 * 1024,
};

function describe_(input: Partial<AndroidUpdateDescriptionInput>): string {
  return describeAndroidUpdate({
    status: "idle",
    update: null,
    error: null,
    progress: null,
    ...input,
  });
}

describe("Android update status copy", () => {
  it.each([
    ["idle", "Check for new fork previews."],
    ["checking", "Checking for updates…"],
    ["current", "You have the latest published preview."],
    ["downloading", "Preparing the update download…"],
    ["verifying", "Verifying the downloaded update…"],
    [
      "permission",
      "Allow updates from this app in Android Settings, then return and tap Install update again.",
    ],
    [
      "installer",
      "Finish installation in Android. If you cancelled, tap Install update to try again.",
    ],
  ] as const)("describes %s", (status, text) => {
    expect(describe_({ status })).toBe(text);
  });

  it("names the available preview", () => {
    expect(describe_({ status: "available", update })).toBe(
      "Preview 0.11.1-preview.14 is available.",
    );
  });

  it("shows measured progress, or bytes alone when the size is unknown", () => {
    expect(describe_({ status: "downloading", update, progress })).toBe(
      "Downloading 25% (1.0 MB / 4.0 MB)",
    );
    expect(
      describe_({ status: "downloading", update, progress: { ...progress, totalBytes: null } }),
    ).toBe("Downloading 1.0 MB…");
    expect(
      describe_({
        status: "downloading",
        update,
        progress: { ...progress, bytesDownloaded: 5 * 1024 * 1024 },
      }),
    ).toBe("Downloading 100% (5.0 MB / 4.0 MB)");
  });

  it("shows the failure message, or generic copy when there is none", () => {
    expect(describe_({ status: "error", error: "Offline" })).toBe("Offline");
    expect(describe_({ status: "error" })).toBe("Unable to update. Try again.");
  });
});
