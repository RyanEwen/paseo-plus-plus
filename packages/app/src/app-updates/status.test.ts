import { beforeEach, describe, expect, it } from "vitest";
import "@/i18n/i18next";
import { androidUpdateStatus } from "./status";
import { useAndroidUpdate } from "./store";

const update = {
  version: "0.11.1-preview.14",
  versionCode: 1_000_000_014,
  url: "https://github.com/RyanEwen/paseo-plus-plus/releases/download/v0.11.1-preview.14/paseo.apk",
  checksumUrl:
    "https://github.com/RyanEwen/paseo-plus-plus/releases/download/v0.11.1-preview.14/SHA256SUMS",
  filename: "paseo.apk",
};

const progress = {
  versionCode: update.versionCode,
  phase: "downloading" as const,
  bytesDownloaded: 1024 * 1024,
  totalBytes: 4 * 1024 * 1024,
};

beforeEach(() => {
  useAndroidUpdate.setState({ status: "idle", update: null, error: null, progress: null });
});

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
    useAndroidUpdate.setState({ status });
    expect(androidUpdateStatus()).toBe(text);
  });

  it("names the available preview", () => {
    useAndroidUpdate.setState({ status: "available", update });
    expect(androidUpdateStatus()).toBe("Preview 0.11.1-preview.14 is available.");
  });

  it("shows measured progress, or bytes alone when the size is unknown", () => {
    useAndroidUpdate.setState({ status: "downloading", update, progress });
    expect(androidUpdateStatus()).toBe("Downloading 25% (1.0 MB / 4.0 MB)");
    useAndroidUpdate.setState({ progress: { ...progress, totalBytes: null } });
    expect(androidUpdateStatus()).toBe("Downloading 1.0 MB…");
    useAndroidUpdate.setState({ progress: { ...progress, bytesDownloaded: 5 * 1024 * 1024 } });
    expect(androidUpdateStatus()).toBe("Downloading 100% (5.0 MB / 4.0 MB)");
  });

  it("shows the failure message, or generic copy when there is none", () => {
    useAndroidUpdate.setState({ status: "error", error: "Offline" });
    expect(androidUpdateStatus()).toBe("Offline");
    useAndroidUpdate.setState({ error: null });
    expect(androidUpdateStatus()).toBe("Unable to update. Try again.");
  });
});
