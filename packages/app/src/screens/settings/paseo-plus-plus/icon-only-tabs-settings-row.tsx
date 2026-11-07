import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { SettingsRow } from "@/components/settings";
import {
  registerSettingsSectionRow,
  type SettingsSectionExtensionRow,
} from "@/components/settings/section-extension-rows";

/** Points to the Explorer tab context menus, which own the Icon-only tabs toggle. */
function IconOnlyTabsSettingsRow() {
  const { t } = useTranslation();
  return (
    <SettingsRow label={t("explorerTabs.iconOnlyLabel")} hint={t("explorerTabs.iconOnlyHint")} />
  );
}

const ICON_ONLY_TABS_ROW: SettingsSectionExtensionRow = {
  id: "icon-only-tabs",
  Row: IconOnlyTabsSettingsRow,
};

/**
 * Adds the Icon-only tabs note to the Explorer settings section while the Paseo++ settings are
 * mounted. Renders nothing itself.
 *
 * The section host is the Explorer settings section from the Explorer settings layer
 * (fix/git-prefs), which renders `<SettingsSectionExtensionRows sectionId="explorer" />`. Without
 * that layer nothing renders the note; the tab context menus still own the toggle. Mount this
 * inside `PaseoPlusPlusSection`, the Explorer section's parent, so the row is registered whenever
 * that section can render. Registering from an effect, rather than at import, unregisters on
 * unmount, so Fast Refresh and Strict Mode never hit the registry's duplicate-id error.
 */
export function IconOnlyTabsSettingsRegistration() {
  useEffect(() => registerSettingsSectionRow("explorer", ICON_ONLY_TABS_ROW), []);
  return null;
}
