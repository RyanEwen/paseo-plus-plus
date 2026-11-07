import { useCallback, useLayoutEffect, useRef } from "react";
import type { LayoutChangeEvent, ScrollView, View } from "react-native";
import type { SharedValue } from "react-native-reanimated";
import { resolveWorkspaceTabScrollOffset } from "./workspace-tab-layout";

export interface WorkspaceTabScrollInput {
  /** Key of the selected tab, or undefined when nothing is selected. */
  activeTabKey: string | undefined;
  /** Identity of the rendered tab order; a change re-measures tabs that only moved. */
  listKey: string;
  enabled: boolean;
  /** Live horizontal scroll offset, updated by the strip's scroll handler. */
  offset: SharedValue<number>;
  /** Content padding before the measured track, so track positions map to scroll positions. */
  leadingInset: number;
}

/** The committed inputs a measurement callback is allowed to act on. */
interface CommittedTabScroll {
  offset: SharedValue<number>;
  leadingInset: number;
}

/**
 * Keep the selected tab of a horizontal strip in view. This follows upstream's
 * `useRevealActiveItem` (components/ui/scroll-reveal.ts), which only scrolls vertically.
 *
 * The selected chip is measured against the track on demand rather than cached, so a tab that
 * moves without resizing (a tab closing to its left) is revealed at its current position. Every
 * trigger (selection or order change, viewport or content size, the chip's own layout) runs the
 * same reveal. Measurement is asynchronous, so only the latest request may scroll, and only while
 * a selection is committed when its callback arrives.
 */
export function useWorkspaceTabScroll({
  activeTabKey,
  listKey,
  enabled,
  offset,
  leadingInset,
}: WorkspaceTabScrollInput) {
  const scrollRef = useRef<ScrollView>(null);
  const trackRef = useRef<View>(null);
  const activeTabRef = useRef<View>(null);
  const geometry = useRef({ viewportWidth: 0, contentWidth: 0 });
  const committed = useRef<CommittedTabScroll | null>(null);
  const measurementRef = useRef(0);

  const revealActiveTab = useCallback(() => {
    const request = ++measurementRef.current;
    const tab = activeTabRef.current;
    const track = trackRef.current;
    if (!committed.current || !tab || !track) return;

    tab.measureLayout(track, (left, _top, width) => {
      const selection = committed.current;
      if (request !== measurementRef.current || !selection || activeTabRef.current !== tab) {
        return;
      }
      if (width <= 0) return;
      const nextOffset = resolveWorkspaceTabScrollOffset({
        ...geometry.current,
        offset: selection.offset.value,
        tabStart: selection.leadingInset + left,
        tabWidth: width,
      });
      scrollRef.current?.scrollTo({ x: nextOffset, animated: false });
    });
  }, []);

  useLayoutEffect(() => {
    // Publish only committed inputs, so a callback held across a commit cannot act on old ones.
    committed.current = enabled && activeTabKey ? { offset, leadingInset } : null;
    revealActiveTab();
    return () => {
      committed.current = null;
      // A measurement started for the previous selection or order must not scroll.
      measurementRef.current += 1;
    };
  }, [activeTabKey, listKey, enabled, offset, leadingInset, revealActiveTab]);

  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      geometry.current.viewportWidth = event.nativeEvent.layout.width;
      revealActiveTab();
    },
    [revealActiveTab],
  );

  const onContentSizeChange = useCallback(
    (width: number) => {
      geometry.current.contentWidth = width;
      revealActiveTab();
    },
    [revealActiveTab],
  );

  return {
    scrollRef,
    trackRef,
    activeTabRef,
    onLayout,
    onContentSizeChange,
    onActiveTabLayout: revealActiveTab,
  };
}
