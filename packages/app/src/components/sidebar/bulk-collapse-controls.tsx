import type { AccessibilityState } from "react-native";
import { useIsCompactFormFactor } from "@/constants/layout";
import { MenuItem, MenuSeparator } from "@/components/ui/menu";
import { useTranslation } from "react-i18next";
import { ChevronsUpDown, ChevronsDownUp } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { mutedIconColorMapping } from "@/components/ui/icon-button-chrome";
import { SidebarHeaderIconButton } from "./header-icon-button";
import {
  useSidebarBulkCollapse,
  type SidebarBulkCollapseActions,
} from "./use-sidebar-bulk-collapse";

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
 * Desktop Workspaces header controls; compact layouts expose these actions in Display
 * through SidebarBulkCollapseMenuItems instead. The shared header button owns the chrome,
 * tooltip and the 44 px touch target on native.
 */
export function SidebarBulkCollapseControls() {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const { enabled, expandAll, collapseAll } = useSidebarBulkCollapse();
  if (!enabled || isCompact) return null;
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

/**
 * Expand all and Collapse all at the top of the compact Display menu, followed by a separator.
 * Desktop layouts show SidebarBulkCollapseControls in the header instead.
 *
 * Takes the actions as a prop because compact menu content mounts inside a bottom sheet, which
 * renders outside SidebarModelProvider: calling useSidebarBulkCollapse here would crash the app.
 */
export function SidebarBulkCollapseMenuItems({ actions }: { actions: SidebarBulkCollapseActions }) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const { enabled, expandAll, collapseAll } = actions;
  if (!enabled || !isCompact) return null;
  return (
    <>
      <MenuItem onSelect={expandAll} testID="sidebar-expand-all">
        {t("sidebar.display.expandAll")}
      </MenuItem>
      <MenuItem onSelect={collapseAll} testID="sidebar-collapse-all">
        {t("sidebar.display.collapseAll")}
      </MenuItem>
      <MenuSeparator />
    </>
  );
}
