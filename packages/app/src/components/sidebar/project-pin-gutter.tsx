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
 * What a workspace row's leading slot paints: a project icon, a status glyph (busy ring, alert,
 * dot or kind icon), the muted idle dot that only holds the rail, or nothing.
 */
export type WorkspaceLeadingSlot = "project" | "status" | "idle" | "none";

/**
 * Resolve the leading slot from the same inputs the row's leading indicator uses.
 *
 * @param input.hasProjectIcon the row leads with its project icon (status rows).
 * @param input.loading an operation loader (startup, archive) owns the slot.
 * @param input.bucket the row's status bucket; every bucket but done paints a glyph.
 * @param input.reserveIdleSpace a done row keeps its idle dot instead of an empty slot.
 */
export function resolveWorkspaceLeadingSlot(input: {
  hasProjectIcon: boolean;
  loading: boolean;
  bucket: SidebarWorkspaceEntry["statusBucket"];
  reserveIdleSpace: boolean;
}): WorkspaceLeadingSlot {
  if (input.hasProjectIcon) return "project";
  if (input.loading || input.bucket !== "done") return "status";
  return input.reserveIdleSpace ? "idle" : "none";
}

/**
 * Paint the project pin inside the existing leading gutter without participating in row layout.
 *
 * A project icon or status glyph keeps its place and the pin sits on it as a corner badge; the
 * idle dot only holds the rail, so the pin takes the slot; an empty slot puts the pin in the gutter
 * to the left of the row. Global pins alone show no marker.
 */
export function WorkspaceProjectPinGutter({
  workspace,
  leadingSlot,
}: {
  workspace: Pick<SidebarWorkspaceEntry, "workspaceKey" | "projectPinnedAt">;
  leadingSlot: WorkspaceLeadingSlot;
}) {
  const enabled = useContext(ProjectPinGutterContext);
  if (!enabled || workspace.projectPinnedAt == null) return null;
  const badge = leadingSlot === "project" || leadingSlot === "status";
  return (
    <View
      style={[styles.rail, badge && styles.badge, leadingSlot === "none" && styles.outside]}
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
  // Optical offsets: a shrunken pin reads as a badge on the slot's lower right without covering
  // the glyph's centre.
  badge: {
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
