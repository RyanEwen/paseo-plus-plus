import { useCallback, type ReactElement } from "react";
import { Text, type AccessibilityState, type PressableStateCallbackType } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { controlHeightForLayout } from "@/components/ui/control-geometry";
import { iconButtonChromeStyle } from "@/components/ui/icon-button-chrome";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

/** Touch target for compact and native header controls: the compact md control height (44 px). */
export const SIDEBAR_HEADER_TOUCH_TARGET = controlHeightForLayout("md", true);

interface SidebarHeaderIconButtonProps {
  /** Accessible name, also shown as the tooltip. */
  label: string;
  onPress: () => void;
  disabled?: boolean;
  accessibilityRole: "button" | "switch";
  accessibilityState: AccessibilityState;
  "aria-checked"?: boolean;
  "aria-expanded"?: boolean;
  testID: string;
  /** Draw the icon at the size the header uses for this layout. */
  renderIcon: (size: number) => ReactElement;
}

/**
 * An icon action in the Workspaces header: shared chrome, a 44 px target on touch layouts, and
 * a tooltip carrying the accessible name.
 */
export function SidebarHeaderIconButton({
  label,
  renderIcon,
  ...triggerProps
}: SidebarHeaderIconButtonProps) {
  const compact = useIsCompactFormFactor();
  const controlStyle = useCallback(
    (interaction: PressableStateCallbackType & { hovered?: boolean }) => [
      iconButtonChromeStyle({ size: "small", compact, state: interaction }),
      (isNative || compact) && styles.touchTarget,
    ],
    [compact],
  );
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger {...triggerProps} style={controlStyle} accessibilityLabel={label}>
        {renderIcon(compact ? 18 : 14)}
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <Text style={styles.label}>{label}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  touchTarget: { minWidth: SIDEBAR_HEADER_TOUCH_TARGET, minHeight: SIDEBAR_HEADER_TOUCH_TARGET },
  label: { color: theme.colors.popoverForeground, fontSize: theme.fontSize.base },
}));
