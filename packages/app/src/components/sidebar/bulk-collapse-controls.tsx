import type { AccessibilityState } from "react-native";
import { useAppSettings } from "@/hooks/use-settings";
import { useTranslation } from "react-i18next";
import { ChevronsUpDown, ChevronsDownUp } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { mutedIconColorMapping } from "@/components/ui/icon-button-chrome";
import { SidebarHeaderIconButton } from "./header-icon-button";
import { useSidebarBulkCollapse } from "./use-sidebar-bulk-collapse";

const ExpandIcon = withUnistyles(ChevronsUpDown);
const CollapseIcon = withUnistyles(ChevronsDownUp);

/** Plain actions carry no toggle or expansion state. */
const ACTION_STATE: AccessibilityState = {};

function renderExpandIcon(size: number) {
  return <ExpandIcon size={size} uniProps={mutedIconColorMapping} />;
}

function renderCollapseIcon(size: number) {
  return <CollapseIcon size={size} uniProps={mutedIconColorMapping} />;
}

/**
 * Desktop Workspaces header controls; compact layouts expose these actions in Display.
 * The shared header button owns the chrome, tooltip and the 44 px touch target on native.
 */
export function SidebarBulkCollapseControls() {
  const { settings } = useAppSettings();
  const { t } = useTranslation();
  const { expandAll, collapseAll } = useSidebarBulkCollapse();
  if (!settings.paseoPlusPlus.sidebarBulkActions) return null;
  return (
    <>
      <SidebarHeaderIconButton
        label={t("sidebar.display.expandAll")}
        onPress={expandAll}
        accessibilityRole="button"
        accessibilityState={ACTION_STATE}
        testID="sidebar-expand-all"
        renderIcon={renderExpandIcon}
      />
      <SidebarHeaderIconButton
        label={t("sidebar.display.collapseAll")}
        onPress={collapseAll}
        accessibilityRole="button"
        accessibilityState={ACTION_STATE}
        testID="sidebar-collapse-all"
        renderIcon={renderCollapseIcon}
      />
    </>
  );
}
