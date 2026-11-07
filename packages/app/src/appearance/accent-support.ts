import { selectHostFeature, type HostFeatureSessionState } from "@/runtime/host-features";

/** Local preferences work independently; a selected settings authority must accept the new key. */
export function selectAccentColorSupport(
  state: HostFeatureSessionState,
  selectedHost: string | null,
): boolean {
  // COMPAT(appSettingsAccentColor): added in v0.11.2, remove gate after 2027-10-14.
  return selectedHost === null || selectHostFeature(state, selectedHost, "appSettingsAccentColor");
}

/** App settings being published, and whether the selected host can store the accent. */
interface AccentExportInput {
  app: Record<string, unknown>;
  supported: boolean;
}

/**
 * Explicit initialization exports only preferences the selected host can store: without support,
 * omit accentColor and keep every other key. Never apply this to pending edits: those keep their
 * original host and failure behavior.
 */
export function exportSupportedAccentSettings({
  app,
  supported,
}: AccentExportInput): Record<string, unknown> {
  if (supported) return app;
  const { accentColor: _accentColor, ...rest } = app;
  return rest;
}
