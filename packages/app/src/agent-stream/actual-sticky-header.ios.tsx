import { useStreamTopOverlayInset } from "./top-overlay";
import type { ReactNode } from "react";
import { useComposerViewportRef } from "@/composer/dock/internal/viewport-ref";
import { NativeMeasurementContext } from "./native-sticky-viewport";
import { resolveNativeMotionOwner } from "./native-actual-row-model";
import { ActualPromptRowsContext } from "./actual-prompt-rows";
import { createNativeStickyLayout } from "./native-sticky-layout";
import { NativeStickyLayoutContext } from "./native-sticky-layout-context";
import { cloneElement, useCallback, useContext, useMemo } from "react";
import { Animated, View, type LayoutChangeEvent } from "react-native";
import RNStickyHeader from "react-native/Libraries/Components/ScrollView/ScrollViewStickyHeader";
import {
  KeyboardDockDisplacementContext,
  useKeyboardDockDisplacement,
} from "@/keyboard/shift/internal/dock-displacement.ios";
import type { NativeStickyProps } from "./native-sticky-contract";

/** Keep the sticky edge below the floating header and at the stationary keyboard clip. */
export function ActualStickyHeader(props: NativeStickyProps) {
  const reportLayout = props.onLayout;
  const enabled = useContext(ActualPromptRowsContext) !== null;
  const zero = useMemo(() => new Animated.Value(0), []);
  const channel = useMemo(
    () =>
      createNativeStickyLayout<LayoutChangeEvent>({
        key: props.children.key,
        index: props.children.props.index,
      }),
    [props.children.key, props.children.props.index],
  );
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      reportLayout(event);
      event.persist();
      channel.publish(event);
    },
    [reportLayout, channel],
  );
  const displacement = useKeyboardDockDisplacement();
  const topOverlayInset = useStreamTopOverlayInset();
  const scrollAnimatedValue = useMemo(
    () =>
      enabled
        ? Animated.add(Animated.add(props.scrollAnimatedValue, displacement), topOverlayInset)
        : zero,
    [enabled, props.scrollAnimatedValue, displacement, topOverlayInset, zero],
  );
  return (
    <RNStickyHeader {...props} onLayout={onLayout} scrollAnimatedValue={scrollAnimatedValue}>
      <View
        style={[props.children.props.style, { overflow: "visible" }]}
        onLayout={props.children.props.onLayout}
        collapsable={false}
      >
        <NativeStickyLayoutContext.Provider value={channel}>
          {cloneElement(props.children, { onLayout: undefined })}
        </NativeStickyLayoutContext.Provider>
      </View>
    </RNStickyHeader>
  );
}

/** Read-only provider-child panes are explicitly unshifted; a partial dock
 * contract still fails rather than silently dropping its physical motion. */
export function NativeActualMotionBoundary({
  allowStandalone,
  children,
}: {
  allowStandalone: boolean;
  children: ReactNode;
}) {
  const inherited = useContext(KeyboardDockDisplacementContext);
  const stationaryViewportRef = useComposerViewportRef();
  const zero = useMemo(() => new Animated.Value(0), []);
  const mode = resolveNativeMotionOwner(
    allowStandalone,
    inherited !== null,
    stationaryViewportRef !== null,
  );
  const value = useMemo(() => ({ mode, stationaryViewportRef }), [mode, stationaryViewportRef]);
  return (
    <KeyboardDockDisplacementContext.Provider value={inherited ?? zero}>
      <NativeMeasurementContext.Provider value={value}>
        {children}
      </NativeMeasurementContext.Provider>
    </KeyboardDockDisplacementContext.Provider>
  );
}
