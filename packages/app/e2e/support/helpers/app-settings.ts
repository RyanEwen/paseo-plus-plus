import type { Page } from "@playwright/test";

const APP_SETTINGS_STORAGE_KEY = "@paseo:app-settings";

/** A partial app settings document; `paseoPlusPlus` is merged key by key. */
export interface AppSettingsPatch {
  paseoPlusPlus?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Merge `patch` into the stored app settings before every page load, keeping settings the test
 * did not mention. Paseo++ preferences merge individually, so seeding one feature switch keeps
 * the others at their stored or default values.
 */
export async function seedAppSettings(page: Page, patch: AppSettingsPatch): Promise<void> {
  await page.addInitScript(
    ({ storageKey, settingsPatch }) => {
      const stored = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
      const paseoPlusPlus = Object.assign({}, stored.paseoPlusPlus, settingsPatch.paseoPlusPlus);
      localStorage.setItem(
        storageKey,
        JSON.stringify(Object.assign({}, stored, settingsPatch, { paseoPlusPlus })),
      );
    },
    { storageKey: APP_SETTINGS_STORAGE_KEY, settingsPatch: patch },
  );
}
