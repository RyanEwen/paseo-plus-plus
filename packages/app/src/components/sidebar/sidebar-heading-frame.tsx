import type { ReactElement, ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

interface SidebarHeadingFrameProps {
  /** The Workspaces heading; null renders the list alone. */
  heading?: ReactElement | null;
  /** Result of `shouldShowSidebarHeading` for the list below. */
  showHeading: boolean;
  /** The mode's list, which owns its own scroll container. */
  children: ReactNode;
}

/**
 * Render the Workspaces heading above the workspace list's scroll container, so the project
 * selector and display controls stay in place while the list scrolls in every grouping mode.
 */
export function SidebarHeadingFrame({ heading, showHeading, children }: SidebarHeadingFrameProps) {
  return (
    <View style={styles.container}>
      {showHeading && heading ? <View style={styles.heading}>{heading}</View> : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
  },
  heading: {
    // The heading left the list's content, so it takes the list's horizontal inset itself and
    // its labels stay on the same rail as the Pinned heading and the rows below.
    paddingHorizontal: theme.spacing[2],
  },
}));
