import { useRetainedPanelActive } from "@/components/retained-panel";
import { useSidebarQuickFilterStore } from "@/stores/sidebar-quick-filter-store";
import { useCallback, useMemo } from "react";
import { Keyboard, View } from "react-native";
import { Filter } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { SearchField } from "@/components/ui/search-field";
import { SIDEBAR_HEADER_TOUCH_TARGET, SidebarHeaderIconButton } from "./header-icon-button";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import type { Theme } from "@/styles/theme";

const FilterIcon = withUnistyles(Filter);
const muted = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const active = (theme: Theme) => ({ color: theme.colors.foreground });

export function SidebarQuickFilterButton() {
  const { t } = useTranslation();
  const mode = useSidebarViewStore((state) => state.groupMode);
  const open = useSidebarQuickFilterStore((state) => state.byMode[mode].open);
  const toggle = useSidebarQuickFilterStore((state) => state.toggle);
  const handleToggle = useCallback(() => {
    if (open) Keyboard.dismiss();
    toggle(mode);
  }, [mode, open, toggle]);
  const label = t(open ? "sidebar.quickFilter.close" : "sidebar.quickFilter.open");
  const state = useMemo(() => ({ expanded: open }), [open]);
  const renderIcon = useCallback(
    (size: number) => <FilterIcon size={size} uniProps={open ? active : muted} />,
    [open],
  );
  return (
    <SidebarHeaderIconButton
      label={label}
      onPress={handleToggle}
      accessibilityRole="button"
      accessibilityState={state}
      aria-expanded={open}
      testID="sidebar-quick-filter-toggle"
      renderIcon={renderIcon}
    />
  );
}

export function SidebarQuickFilterInput() {
  const activePanel = useRetainedPanelActive();
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const mode = useSidebarViewStore((state) => state.groupMode);
  const query = useSidebarQuickFilterStore((state) => state.byMode[mode]);
  const setText = useSidebarQuickFilterStore((state) => state.setText);
  const close = useSidebarQuickFilterStore((state) => state.close);
  const handleChange = useCallback((text: string) => setText(mode, text), [mode, setText]);
  const handleClose = useCallback(() => {
    close(mode);
    Keyboard.dismiss();
  }, [close, mode]);
  if (!query.open || !activePanel) return null;
  return (
    <View style={styles.inputRow}>
      <SearchField
        key={mode}
        value={query.text}
        onChangeText={handleChange}
        autoFocus
        onEscape={handleClose}
        clearTouchTargetSize={isNative || compact ? SIDEBAR_HEADER_TOUCH_TARGET : undefined}
        placeholder={t("sidebar.quickFilter.placeholder")}
        clearAccessibilityLabel={t("sidebar.quickFilter.clear")}
        testID="sidebar-quick-filter-input"
        clearTestID="sidebar-quick-filter-clear"
      />
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  inputRow: {
    flexDirection: "row",
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[2],
  },
}));
