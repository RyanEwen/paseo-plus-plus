import type { ReactElement, ReactNode, RefObject } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";
import type { PaneHost } from "@/panels/panel-manifest";

/**
 * Whether compact tabs render as plain slots instead of the sortable list.
 * Only compact web Explorer keeps its sortable owner; main, sheet and native compact strips
 * leave long press to the tab's actions menu.
 */
export function usesCompactTabSlots(input: { host: PaneHost; compact: boolean }): boolean {
  return input.compact && !(isWeb && input.host === "explorer");
}

/** The measured track that compact selected-tab reveal positions its chips against. */
export function CompactTabTrack({
  trackRef,
  children,
}: {
  trackRef: RefObject<View | null>;
  children: ReactNode;
}): ReactElement {
  return (
    <View ref={trackRef} collapsable={false} style={styles.track}>
      {children}
    </View>
  );
}

/**
 * Wrap one compact chip so the selected one can be measured against the track.
 * Every chip keeps the same wrapper, so a selection change never remounts a chip.
 */
export function CompactTabMeasure({
  selected,
  activeTabRef,
  onActiveTabLayout,
  children,
}: {
  selected: boolean;
  activeTabRef: RefObject<View | null>;
  onActiveTabLayout: () => void;
  children: ReactNode;
}): ReactElement {
  return (
    <View
      ref={selected ? activeTabRef : undefined}
      collapsable={false}
      onLayout={selected ? onActiveTabLayout : undefined}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: "row",
    alignItems: "center",
  },
});
