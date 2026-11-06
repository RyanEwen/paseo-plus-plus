import { useCallback, useLayoutEffect, useRef } from "react";
import { ScrollView, type LayoutChangeEvent, type LayoutRectangle } from "react-native";
import type { SharedValue } from "react-native-reanimated";
import { resolveWorkspaceTabScrollOffset } from "./workspace-tab-layout";

interface CommittedTabScrollInput {
  activeTabKey: string | undefined;
  enabled: boolean;
  offset: SharedValue<number>;
}

/**
 * Reveal the selected tab after native measurements, selection, or viewport changes.
 * The shared scroll offset follows user scrolling without a React update for every frame.
 */
export function useWorkspaceTabScroll({
  activeTabKey,
  enabled,
  offset,
}: {
  activeTabKey: string | undefined;
  enabled: boolean;
  offset: SharedValue<number>;
}) {
  const scrollRef = useRef<ScrollView>(null);
  const geometry = useRef({ viewportWidth: 0, contentWidth: 0 });
  const tabFrames = useRef(new Map<string, { x: number; width: number }>());
  const committed = useRef<CommittedTabScrollInput | null>(null);

  const revealActiveTab = useCallback(() => {
    const selection = committed.current;
    if (!selection?.enabled || !selection.activeTabKey) {
      return;
    }
    const frame = tabFrames.current.get(selection.activeTabKey);
    if (!frame) {
      return;
    }

    const nextOffset = resolveWorkspaceTabScrollOffset({
      ...geometry.current,
      offset: selection.offset.value,
      tabStart: frame.x,
      tabWidth: frame.width,
    });
    scrollRef.current?.scrollTo({ x: nextOffset, animated: false });
  }, []);

  useLayoutEffect(() => {
    // Native measurement delivery may retain an older callback across a selection commit.
    // Publish only committed inputs, so even that callback reveals the current selection.
    committed.current = { activeTabKey, enabled, offset };
    revealActiveTab();
    return () => {
      committed.current = null;
    };
  }, [activeTabKey, enabled, offset, revealActiveTab]);

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

  // Sortable roots publish plain measured frames; ordinary slots use the same owning boundary.
  const onTabFrame = useCallback(
    (tabKey: string, frame: LayoutRectangle) => {
      if (frame.width <= 0 || frame.height <= 0) return;
      tabFrames.current.set(tabKey, frame);
      revealActiveTab();
    },
    [revealActiveTab],
  );
  const onTabLayout = useCallback(
    (tabKey: string, event: LayoutChangeEvent) => onTabFrame(tabKey, event.nativeEvent.layout),
    [onTabFrame],
  );

  return { scrollRef, onLayout, onContentSizeChange, onTabLayout, onTabFrame };
}
