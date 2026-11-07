import { useCallback, useMemo } from "react";
import { Bell } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { withUnistyles } from "react-native-unistyles";
import { useSidebarDisplayPreferences } from "./display-preferences/model";
import { SidebarHeaderIconButton } from "./header-icon-button";
import type { Theme } from "@/styles/theme";

const BellIcon = withUnistyles(Bell);
const outline = (theme: Theme) => ({ color: theme.colors.foregroundMuted, fill: "transparent" });
const filled = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
  fill: theme.colors.foregroundMuted,
});

/** Mode is a direct action; Display remains a separate menu for the active mode. */
export function SidebarViewModeButton() {
  const { t } = useTranslation();
  const preferences = useSidebarDisplayPreferences();
  const mode = preferences.grouping;
  const next = mode === "project" ? "status" : "project";
  const modeLabel = t("sidebar.display.modeToggle", {
    current: t(`sidebar.display.grouping.${mode}`),
    next: t(`sidebar.display.grouping.${next}`),
  });
  const label = preferences.preferencesDisabledReason
    ? `${modeLabel} ${preferences.preferencesDisabledReason}`
    : modeLabel;
  const state = useMemo(() => ({ checked: mode === "status" }), [mode]);
  const renderIcon = useCallback(
    (size: number) => <BellIcon size={size} uniProps={mode === "status" ? filled : outline} />,
    [mode],
  );
  return (
    <SidebarHeaderIconButton
      label={label}
      disabled={preferences.preferencesDisabled}
      onPress={preferences.toggleGrouping}
      accessibilityRole="switch"
      aria-checked={mode === "status"}
      accessibilityState={state}
      testID="sidebar-view-mode-toggle"
      renderIcon={renderIcon}
    />
  );
}
