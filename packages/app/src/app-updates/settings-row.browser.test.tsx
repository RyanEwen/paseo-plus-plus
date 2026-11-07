import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { within } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/i18n/i18next"; // registers the update copy resources
import { AndroidAppUpdateRow } from "./settings-row";
import type { AndroidUpdater } from "./store";
import {
  buildAndroidUpdate,
  createFakeAndroidUpdater,
  type FakeAndroidUpdateReleases,
  type FakeAndroidUpdaterNative,
} from "./test-utils/fake-android-updater";
import { AndroidUpdaterProvider } from "./use-android-updater";

// Chromium renders the real update row and store; Android and the release service are fakes.
const update = buildAndroidUpdate(14);
let root: Root;
let container: HTMLDivElement;
let updater: AndroidUpdater;
let native: FakeAndroidUpdaterNative;
let releases: FakeAndroidUpdateReleases;

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  ({ updater, native, releases } = createFakeAndroidUpdater());
  container = document.createElement("div");
  container.style.width = "360px";
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <AndroidUpdaterProvider value={updater}>
        <AndroidAppUpdateRow />
      </AndroidUpdaterProvider>,
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function click(label: string) {
  await act(async () => within(container).getByRole("button", { name: label }).click());
}

describe("Android update feedback", () => {
  it("shows byte progress and verification while preventing duplicate update actions", async () => {
    await click("Check");
    native.holdDownloads = true;

    // Keep the real store operation pending while native events update the rendered row.
    let installation!: Promise<void>;
    act(() => {
      installation = updater.getState().install();
    });
    await vi.waitFor(() => expect(native.downloads).toHaveLength(1));
    const report = (
      totalBytes: number | null,
      phase: "downloading" | "verifying" = "downloading",
    ) => {
      act(() =>
        native.emitProgress({
          versionCode: update.versionCode,
          bytesDownloaded: 1024 * 1024,
          totalBytes,
          phase,
        }),
      );
    };

    try {
      report(4 * 1024 * 1024);
      expect(within(container).getByText("Downloading 25% (1.0 MB / 4.0 MB)")).toBeTruthy();
      expect(
        within(container).getByRole("button", { name: "Check" }).getAttribute("aria-disabled"),
      ).toBe("true");
      expect(
        within(container)
          .getByRole("button", { name: "Install update" })
          .getAttribute("aria-disabled"),
      ).toBe("true");
      expect(native.installs).toEqual([]);

      report(null);
      expect(within(container).getByText("Downloading 1.0 MB…")).toBeTruthy();
      report(1024 * 1024, "verifying");
      expect(within(container).getByText("Verifying the downloaded update…")).toBeTruthy();
      expect(container.scrollWidth).toBeLessThanOrEqual(container.clientWidth);
      expect(native.installs).toEqual([]);
    } finally {
      await act(async () => {
        native.finishDownloads();
        await installation;
      });
    }
    expect(within(container).getByText(/Finish installation in Android/)).toBeTruthy();
  });

  it("shows permission guidance, retains the install action, and acknowledges the installer handoff", async () => {
    await click("Check");
    expect(
      within(container).getByText("Preview 0.11.1-preview.14 is available.").textContent,
    ).toBe("Preview 0.11.1-preview.14 is available.");
    native.installResults = ["permission_required"];
    await click("Install update");
    expect(
      within(container).getByText(/Allow updates from this app in Android Settings/).textContent,
    ).toContain("tap Install update again");
    expect(container.scrollWidth).toBeLessThanOrEqual(container.clientWidth);
    await click("Install update");
    expect(within(container).getByText(/Finish installation in Android/).textContent).toContain(
      "If you cancelled",
    );
    expect(native.downloads).toHaveLength(1);
  });

  it("keeps a failed download visible and allows retry", async () => {
    await click("Check");
    native.downloadFailures = [new Error("Update checksum mismatch")];
    await click("Install update");
    expect(within(container).getByText("Update checksum mismatch").textContent).toBe(
      "Update checksum mismatch",
    );
    expect(native.installs).toEqual([]);
    await click("Install update");
    expect(within(container).getByText(/Finish installation in Android/).textContent).toContain(
      "Finish installation",
    );
  });

  it("shows check failures and recovers to the current-version acknowledgement", async () => {
    releases.next = new Error("Offline");
    await click("Check");
    expect(within(container).getByText("Offline").textContent).toBe("Offline");
    releases.next = null;
    await click("Check");
    expect(within(container).getByText("You have the latest published preview.").textContent).toBe(
      "You have the latest published preview.",
    );
  });
});
