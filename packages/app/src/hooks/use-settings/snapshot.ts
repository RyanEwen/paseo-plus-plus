import type { QueryClient } from "@tanstack/react-query";
import { APP_SETTINGS_QUERY_KEY, DEFAULT_CLIENT_SETTINGS, type AppSettings } from "./storage";

/**
 * The app settings currently held by `client`, or the defaults when settings have not loaded.
 *
 * For code outside React that applies a preference at the moment it runs (a checkout status
 * push, a new workspace layout). React components read settings through `useAppSettings`.
 */
export function readAppSettingsSnapshot(client: QueryClient): AppSettings {
  return client.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY) ?? DEFAULT_CLIENT_SETTINGS;
}

/** The app settings held by `client`, or undefined until they have loaded from storage. */
export function readLoadedAppSettings(client: QueryClient): AppSettings | undefined {
  return client.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY);
}
