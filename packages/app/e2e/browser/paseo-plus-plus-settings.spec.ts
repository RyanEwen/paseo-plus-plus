import type { Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";

const SETTINGS_KEY = "@paseo:app-settings";

/** Open Paseo++ settings through the sidebar, as a user does. */
async function openPaseoPlusPlusSettings(page: Page) {
  await gotoAppShell(page);
  await openSettings(page);
  const section = page.getByTestId("paseo-plus-plus-settings");
  await expect(section).toBeVisible();
  return section;
}

/** Read the saved Paseo++ preferences from the app's settings storage. */
async function readSavedPreferences(page: Page): Promise<Record<string, unknown> | undefined> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw).paseoPlusPlus : undefined;
  }, SETTINGS_KEY);
}

/** Make this page's settings writes throw until the returned function restores them. */
async function failSettingsWrites(page: Page): Promise<() => Promise<void>> {
  await page.evaluate((key) => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name: string, value: string) {
      if (name === key) throw new Error("Owned fixture storage failure");
      original.call(this, name, value);
    };
    window.addEventListener(
      "paseo-plus-plus-restore-storage",
      () => {
        Storage.prototype.setItem = original;
      },
      { once: true },
    );
  }, SETTINGS_KEY);
  return async () => {
    await page.evaluate(() => window.dispatchEvent(new Event("paseo-plus-plus-restore-storage")));
  };
}

test.describe("Paseo++ feature switches", () => {
  test("a turned-off feature stays off after reload", async ({ page }) => {
    const section = await openPaseoPlusPlusSettings(page);
    const toggle = section.getByTestId("paseo-plus-plus-previousAgents").getByRole("switch");
    await expect(toggle).toBeChecked();

    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await page.reload();

    await expect(
      page.getByTestId("paseo-plus-plus-previousAgents").getByRole("switch"),
    ).not.toBeChecked();
    expect(await readSavedPreferences(page)).toMatchObject({ previousAgents: false });
  });

  test("a failed save shows the row error and keeps the previous choice", async ({ page }) => {
    const section = await openPaseoPlusPlusSettings(page);
    const row = section.getByTestId("paseo-plus-plus-previousAgents");
    const toggle = row.getByRole("switch");
    await expect(toggle).toBeChecked();
    const savedBefore = await page.evaluate((key) => localStorage.getItem(key), SETTINGS_KEY);

    const restoreWrites = await failSettingsWrites(page);
    await toggle.click();

    await expect(row.getByText("Unable to save. Try again.", { exact: true })).toBeVisible();
    await expect(toggle).toBeChecked();
    expect(await page.evaluate((key) => localStorage.getItem(key), SETTINGS_KEY)).toBe(savedBefore);

    // Retrying the same control after storage recovers saves the choice.
    await restoreWrites();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect(row.getByText("Unable to save. Try again.", { exact: true })).toHaveCount(0);
  });
});

test.describe("Explorer and Changes settings", () => {
  test("persist automatic Explorer opening and single-file Changes", async ({ page }) => {
    await openPaseoPlusPlusSettings(page);
    const autoOpen = page.getByRole("switch", {
      name: "Open sidebar for new workspaces",
      exact: true,
    });
    await expect(autoOpen).toHaveAttribute("aria-checked", "false");
    await autoOpen.click();
    await expect(autoOpen).toHaveAttribute("aria-checked", "true");
    await page
      .getByRole("button", { name: "Clicking a file in Changes: All changed files", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Selected file only", exact: true }).click();
    await expect(
      page.getByRole("button", {
        name: "Clicking a file in Changes: Selected file only",
        exact: true,
      }),
    ).toBeVisible();
    const autoSwitch = page.getByRole("switch", {
      name: "Automatically switch comparison",
      exact: true,
    });
    const defaultComparison = page.getByRole("button", {
      name: "Default comparison: Uncommitted",
      exact: true,
    });
    await expect(autoSwitch).toHaveAttribute("aria-checked", "false");
    await autoSwitch.click();
    await expect(defaultComparison).toBeDisabled();
    await autoSwitch.click();
    await expect(defaultComparison).toBeEnabled();
    await defaultComparison.click();
    await page.getByRole("menuitem", { name: "Committed", exact: true }).click();
    await page.reload();
    await expect(autoOpen).toHaveAttribute("aria-checked", "true");
    await expect(
      page.getByRole("button", {
        name: "Clicking a file in Changes: Selected file only",
        exact: true,
      }),
    ).toBeVisible();
    await expect(autoSwitch).toHaveAttribute("aria-checked", "false");
    await expect(
      page.getByRole("button", { name: "Default comparison: Committed", exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("explorer-settings.png") });
  });
});
