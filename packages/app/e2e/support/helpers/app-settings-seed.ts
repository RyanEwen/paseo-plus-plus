import type { Page } from "@playwright/test";

const APP_SETTINGS_KEY = "@paseo:app-settings";

/**
 * Merge `patch` into the app's stored settings before every page load, keeping settings the
 * fixtures seeded (such as chatDisplay). Use it for preferences a test holds fixed; a test that
 * changes the same preference in the UI should set it through the UI instead.
 */
export async function seedAppSettings(page: Page, patch: Record<string, unknown>): Promise<void> {
  await page.addInitScript(
    ({ key, values }) => {
      const settings = JSON.parse(localStorage.getItem(key) ?? "{}");
      localStorage.setItem(key, JSON.stringify({ ...settings, ...values }));
    },
    { key: APP_SETTINGS_KEY, values: patch },
  );
}
