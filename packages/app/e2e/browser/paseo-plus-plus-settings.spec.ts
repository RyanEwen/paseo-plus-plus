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
