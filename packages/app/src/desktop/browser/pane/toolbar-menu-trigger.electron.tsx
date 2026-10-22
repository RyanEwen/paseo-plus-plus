import { useCallback, type ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { ChevronDown } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";

const ThemedChevronDown = withUnistyles(ChevronDown);
const mutedIcon = (theme: { colors: { foregroundMuted: string } }) => ({
  color: theme.colors.foregroundMuted,
});

/** Shared geometry for browser toolbar menus, wider than a single-icon button. */
export const toolbarMenuStyles = StyleSheet.create((theme) => ({
  trigger: {
    width: "auto",
    minWidth: 48,
    flexShrink: 0,
    paddingHorizontal: theme.spacing[2],
  },
  content: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
}));

/** Keep the icon and disclosure aligned for device, extension and zoom menus. */
export function ToolbarMenuContent({ children }: { children: ReactNode }) {
  return (
    <View style={toolbarMenuStyles.content}>
      {children}
      <ThemedChevronDown size={12} uniProps={mutedIcon} />
    </View>
  );
}

/** Preserve each toolbar's interaction colors while sharing disclosure button sizing. */
export function useToolbarMenuTriggerStyle(
  style: (state: { hovered?: boolean; pressed?: boolean }) => StyleProp<ViewStyle>,
) {
  return useCallback(
    (state: { hovered?: boolean; pressed?: boolean }) => [style(state), toolbarMenuStyles.trigger],
    [style],
  );
}
