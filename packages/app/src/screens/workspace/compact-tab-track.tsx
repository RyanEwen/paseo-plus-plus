import type { ReactElement, ReactNode, RefObject } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { controlHeightForLayout } from "@/components/ui/control-geometry";
import { isWeb } from "@/constants/platform";
import type { PaneHost } from "@/panels/panel-manifest";

/**
 * Compact (phone) tab strip decisions and wrappers for the shared workspace tab row.
 * They live here so the upstream row and chip carry no compact-only branches of their own.
 */

/** Compact tab chips and the compact new-tab button keep the full touch-target height. */
export const COMPACT_TAB_CONTROL_HEIGHT = controlHeightForLayout("md", true);

const styles = StyleSheet.create((theme) => ({
  track: {
    flexDirection: "row",
    alignItems: "center",
  },
  container: {
    height: COMPACT_TAB_CONTROL_HEIGHT + theme.spacing[2],
    borderBottomWidth: 0,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  tab: {
    height: COMPACT_TAB_CONTROL_HEIGHT,
  },
  tabFrame: {
    flexDirection: "row",
    alignItems: "center",
  },
}));

export interface CompactTabStripLayout {
  /** Compact main tabs divide the measured scroll track equally. */
  fillAvailableWidth: boolean;
  /** Render plain slots instead of the sortable list. */
  rendersSlots: boolean;
}

/**
 * Choose how a compact strip lays out its tabs. Only compact web Explorer keeps its sortable
 * owner; main, sheet and native compact strips leave long press to the tab's actions menu.
 */
export function compactTabStripLayout(input: {
  host: PaneHost;
  compact: boolean;
}): CompactTabStripLayout {
  return {
    fillAvailableWidth: input.compact && input.host === "main",
    rendersSlots: input.compact && !(isWeb && input.host === "explorer"),
  };
}

/** Key of the selected tab, or undefined when none is selected. */
export function selectedTabKey(
  tabs: ReadonlyArray<{ isActive: boolean; tab: { key: string } }>,
): string | undefined {
  return tabs.find((item) => item.isActive)?.tab.key;
}

/** Filling strips size tabs from the scroll track, which already excludes the toolbar. */
export function measuredTabTrackWidth(input: {
  fillAvailableWidth: boolean;
  scrollWidth: number;
  containerWidth: number;
}): number {
  return input.fillAvailableWidth ? input.scrollWidth : input.containerWidth;
}

/** Compact strips always scroll; wide strips scroll only when tabs cannot fit. */
export function tabStripScrolls(input: {
  compact: boolean;
  requiresHorizontalScrollFallback: boolean;
}): boolean {
  return input.compact || input.requiresHorizontalScrollFallback;
}

/** Compact strips keep + in the toolbar slot instead of inline after the tabs. */
export function showsInlineNewTabButton(input: {
  compact: boolean;
  requiresHorizontalScrollFallback: boolean;
}): boolean {
  return !input.compact && !input.requiresHorizontalScrollFallback;
}

/** The compact strip's container style, or nothing for wide strips. */
export function compactTabStripContainerStyle(compact: boolean) {
  return compact ? styles.container : undefined;
}

export interface CompactTabChipPresentation {
  tabStyle: typeof styles.tab | undefined;
  frameStyle: typeof styles.tabFrame | undefined;
  accessibilityRole: "tab" | "button";
}

const WIDE_TAB_CHIP: CompactTabChipPresentation = {
  tabStyle: undefined,
  frameStyle: undefined,
  accessibilityRole: "button",
};

const COMPACT_TAB_CHIP: CompactTabChipPresentation = {
  tabStyle: styles.tab,
  frameStyle: styles.tabFrame,
  accessibilityRole: "tab",
};

/** Chip presentation for the form factor; both results are stable module constants. */
export function compactTabChipPresentation(compact: boolean): CompactTabChipPresentation {
  return compact ? COMPACT_TAB_CHIP : WIDE_TAB_CHIP;
}

/** Compact chips close from their actions menu, so they never show an inline X. */
export function showsInlineCloseButton(input: {
  showCloseButton: boolean;
  compact: boolean;
}): boolean {
  return input.showCloseButton && !input.compact;
}

/** The measured track that compact selected-tab reveal positions its chips against. */
function CompactTabTrack({
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
 * The strip's scroll content. Wide strips render the sortable list unchanged; compact strips put
 * either plain slots or the sortable list inside the measured track.
 */
export function TabStripContent<T>({
  compact,
  rendersSlots,
  trackRef,
  tabs,
  renderSlot,
  children,
}: {
  compact: boolean;
  rendersSlots: boolean;
  trackRef: RefObject<View | null>;
  tabs: readonly T[];
  renderSlot: (item: T, index: number) => ReactElement;
  /** The sortable tab list. */
  children: ReactElement;
}): ReactElement {
  if (!compact) return children;
  return (
    <CompactTabTrack trackRef={trackRef}>
      {rendersSlots ? tabs.map(renderSlot) : children}
    </CompactTabTrack>
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
