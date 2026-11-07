import { createContext, useContext } from "react";
import { View } from "react-native";
import { Pin } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { Theme } from "@/styles/theme";

const ProjectPinGutterContext = createContext(false);
export const ProjectPinGutterProvider = ProjectPinGutterContext.Provider;
const PinIcon = withUnistyles(Pin);
const pinMapping = (theme: Theme) => ({
  color: theme.colors.foregroundExtraMuted,
  size: theme.iconSize.xs,
});

/**
 * Paint the project pin inside the existing leading gutter without participating in row layout.
 *
 * @param occupied the leading slot already shows something, so the pin shrinks to a corner badge.
 * @param outside the leading slot is empty, so the pin sits in the gutter left of the row.
 */
export function WorkspaceProjectPinGutter({
  workspace,
  occupied = false,
  outside = false,
}: {
  occupied?: boolean;
  outside?: boolean;
  workspace: Pick<SidebarWorkspaceEntry, "workspaceKey" | "projectPinnedAt">;
}) {
  const enabled = useContext(ProjectPinGutterContext);
  if (!enabled || workspace.projectPinnedAt == null) return null;
  return (
    <View
      style={[styles.rail, occupied && styles.annotation, outside && styles.outside]}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      aria-hidden
      testID={`sidebar-project-pin-icon-${workspace.workspaceKey}`}
    >
      <PinIcon uniProps={pinMapping} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // Optical offsets: the shrunken pin reads as a badge on the slot's lower right without covering
  // the glyph's centre.
  annotation: {
    transform: [{ scale: 0.65 }],
    left: theme.iconSize.md / 2,
    top: theme.spacing[1],
  },
  // An empty slot has no width, so the pin sits in the gutter one slot to the left of the title.
  outside: { left: -(theme.iconSize.md + theme.spacing[2]) },
  rail: {
    position: "absolute",
    left: 0,
    top: 0,
    width: theme.iconSize.md,
    height: theme.iconSize.md + theme.spacing[1],
    alignItems: "center",
    justifyContent: "center",
  },
}));
