import { selectHostFeature, type HostFeatureSessionState } from "@/runtime/host-features";

/** Device-only display choices need no host; synchronized choices require the selected authority. */
export function selectChatPreferencesSupport(
  state: HostFeatureSessionState,
  selectedHost: string | null,
): boolean {
  // COMPAT(appSettingsChatPreferences): added in v0.15.0, remove gate after 2027-05-02.
  return (
    selectedHost === null || selectHostFeature(state, selectedHost, "appSettingsChatPreferences")
  );
}

/** Initialization negotiates new keys; backups and device-local choices keep both. */
export function exportSupportedChatPreferences(
  app: Record<string, unknown>,
  supported: boolean,
  purpose: "backup" | "publish",
): Record<string, unknown> {
  if (purpose === "backup" || supported) return app;
  const { chatDisplay: _chatDisplay, sendShortcut: _sendShortcut, ...rest } = app;
  return rest;
}
