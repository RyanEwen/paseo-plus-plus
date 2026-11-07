import type { Page } from "@playwright/test";

const APP_SETTINGS_KEY = "@paseo:app-settings";

/**
 * Merge `settings` into the stored app settings before every page load. Nested objects such as
 * `paseoPlusPlus` are merged one level deep, so a spec can set one fork preference without
 * dropping others. Values seeded earlier, including the fixture's chat display, survive unless
 * `settings` replaces them.
 */
export async function seedAppSettings(page: Page, settings: Record<string, unknown>): Promise<void> {
  await page.addInitScript(
    ({ key, partial }) => {
      const stored = JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...stored };
      for (const [name, value] of Object.entries(partial)) {
        const previous = stored[name];
        const bothObjects =
          typeof value === "object" &&
          value !== null &&
          !Array.isArray(value) &&
          typeof previous === "object" &&
          previous !== null &&
          !Array.isArray(previous);
        merged[name] = bothObjects ? { ...previous, ...value } : value;
      }
      localStorage.setItem(key, JSON.stringify(merged));
    },
    { key: APP_SETTINGS_KEY, partial: settings },
  );
}
