import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import {
  FlatList,
  type FlatListProps,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import type { StreamItem } from "@/types/stream";
import type { BottomAnchorUserScroll } from "../bottom-anchor-controller";
import {
  createNativeViewportLifetime,
  type NativeViewportLifetime,
  type NativeViewportRefEffects,
  type NativeViewportRefOwner,
} from "../native-actual-row-model";

export interface NativeViewportHandlers {
  refEffects: NativeViewportRefEffects<FlatList<StreamItem>>;
  onLayout(origin: NativeViewportLifetime, event: LayoutChangeEvent): void;
  onContentSizeChange(origin: NativeViewportLifetime, width: number, height: number): void;
  onScroll(origin: NativeViewportLifetime, event: NativeSyntheticEvent<NativeScrollEvent>): void;
  onScrollBeginDrag(
    origin: NativeViewportLifetime,
    event: NativeSyntheticEvent<NativeScrollEvent>,
  ): void;
  onScrollEndDrag(
    origin: NativeViewportLifetime,
    event: NativeSyntheticEvent<NativeScrollEvent>,
  ): void;
  onMomentumScrollBegin(origin: NativeViewportLifetime): void;
  onMomentumScrollEnd(
    origin: NativeViewportLifetime,
    event: NativeSyntheticEvent<NativeScrollEvent>,
  ): void;
}

export interface NativeViewportListProps extends Omit<
  FlatListProps<StreamItem>,
  keyof NativeViewportHandlers
> {
  viewportHandlers: NativeViewportHandlers;
}

export interface NativeViewportGesture {
  origin: NativeViewportLifetime;
  scroll: BottomAnchorUserScroll;
}

/** This component always owns the same unkeyed FlatList child. A replacement
 * component creates new callbacks with a new origin; delayed callbacks retain
 * the old one. There is no additional native View or forced remount.
 */
export function NativeViewportList({ viewportHandlers, ...props }: NativeViewportListProps) {
  const originRef = useRef<NativeViewportRefOwner<FlatList<StreamItem>> | null>(null);
  if (!originRef.current) originRef.current = createNativeViewportLifetime<FlatList<StreamItem>>();
  const origin = originRef.current;
  useLayoutEffect(
    () => origin.activate(viewportHandlers.refEffects),
    [origin, viewportHandlers.refEffects],
  );
  const attach = useCallback(
    (viewport: FlatList<StreamItem> | null) =>
      origin.bindRef(viewport, viewportHandlers.refEffects),
    [origin, viewportHandlers],
  );
  const events = useMemo<
    Pick<
      FlatListProps<StreamItem>,
      | "onLayout"
      | "onContentSizeChange"
      | "onScroll"
      | "onScrollBeginDrag"
      | "onScrollEndDrag"
      | "onMomentumScrollBegin"
      | "onMomentumScrollEnd"
    >
  >(
    () => ({
      onLayout: (event) => viewportHandlers.onLayout(origin, event),
      onContentSizeChange: (width, height) =>
        viewportHandlers.onContentSizeChange(origin, width, height),
      onScroll: (event) => viewportHandlers.onScroll(origin, event),
      onScrollBeginDrag: (event) => viewportHandlers.onScrollBeginDrag(origin, event),
      onScrollEndDrag: (event) => viewportHandlers.onScrollEndDrag(origin, event),
      onMomentumScrollBegin: () => viewportHandlers.onMomentumScrollBegin(origin),
      onMomentumScrollEnd: (event) => viewportHandlers.onMomentumScrollEnd(origin, event),
    }),
    [origin, viewportHandlers],
  );
  return <FlatList {...props} {...events} ref={attach} />;
}
