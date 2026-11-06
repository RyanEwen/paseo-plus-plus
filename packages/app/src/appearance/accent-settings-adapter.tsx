import {
  useSettingsDomainAdapter,
  type SettingsDomainAdapter,
} from "@/hooks/use-settings/domain-adapters";
import { useSessionStore } from "@/stores/session-store";
import { exportSupportedAccentSettings, selectAccentColorSupport } from "./accent-support";

/**
 * Publication filter for the accent preference. A selected settings host without the
 * appSettingsAccentColor capability would reject the field, so explicit publication omits it;
 * backups and device values keep the full choice.
 */
const ACCENT_SETTINGS_ADAPTER: SettingsDomainAdapter = {
  id: "accent",
  filterAppExport(app, context) {
    const supported = selectAccentColorSupport(useSessionStore.getState(), context.selectedHost);
    return exportSupportedAccentSettings(app, supported);
  },
};

/**
 * Register the accent adapter while mounted. Mount it before any settings consumer starts so
 * the filter is in place for its first publication.
 */
export function AccentSettingsAdapter() {
  useSettingsDomainAdapter(ACCENT_SETTINGS_ADAPTER);
  return null;
}
