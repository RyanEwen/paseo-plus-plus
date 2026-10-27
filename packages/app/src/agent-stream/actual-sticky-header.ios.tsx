import { useStreamTopOverlayInset } from "./top-overlay";
import type { ReactNode } from "react";
import { useComposerViewportRef } from "@/composer/dock/internal/viewport-ref";
import { NativeMeasurementContext } from "./native-sticky-viewport";
import { resolveNativeMotionOwner } from "./native-actual-row-model";
import { ActualPromptRowsContext } from "./actual-prompt-rows";
import { createNativeStickyLayout } from "./native-sticky-layout";
import { NativeStickyLayoutContext } from "./native-sticky-layout-context";
import {
  cloneElement,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  useLayoutEffect,
  useImperativeHandle,
} from "react";
import { Animated, View, type LayoutChangeEvent } from "react-native";
import RNStickyHeader from "react-native/Libraries/Components/ScrollView/ScrollViewStickyHeader";
import {
  KeyboardDockDisplacementContext,
  useKeyboardDockDisplacement,
} from "@/keyboard/shift/internal/dock-displacement.ios";
import type { NativeStickyProps, NativeStickyHandle } from "./native-sticky-contract";
import type { NaturalMessageGeometry } from "@/components/user-message-flow-model";
import { nativeStickyInterpolation, resolveNativeStickyHeights } from "./native-actual-row-model";

/** Keep the sticky edge below the floating header and at the stationary keyboard clip. */
export function ActualStickyHeader({ ref, ...props }: NativeStickyProps) {
  const reportLayout = props.onLayout;
  const rows = useContext(ActualPromptRowsContext);
  const enabled = rows !== null;
  const zero = useMemo(() => new Animated.Value(0), []);
  const channel = useMemo(
    () =>
      createNativeStickyLayout<LayoutChangeEvent>({
        key: props.children.key,
        index: props.children.props.index,
        scope: rows?.scope,
      }),
    [props.children.key, props.children.props.index, rows?.scope],
  );
  const [body, setBody] = useState<{
    channel: typeof channel;
    geometry: NaturalMessageGeometry | null;
  } | null>(null);
  const [measurement, setMeasurement] = useState<{
    channel: typeof channel;
    frame: { y: number; height: number };
  } | null>(null);
  const layout = measurement?.channel === channel ? measurement.frame : null;
  const [next, setNext] = useState(props.nextHeaderLayoutY ?? null);
  const inner = useRef<NativeStickyHandle>(null);
  useLayoutEffect(
    () => channel.subscribeBody((geometry) => setBody({ channel, geometry })),
    [channel],
  );
  useLayoutEffect(
    () => setNext(props.nextHeaderLayoutY ?? null),
    [channel, props.nextHeaderLayoutY],
  );
  useImperativeHandle(
    ref,
    () => ({
      setNextHeaderY(value) {
        setNext(value);
        inner.current?.setNextHeaderY(value);
      },
    }),
    [],
  );
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      setMeasurement({ channel, frame: event.nativeEvent.layout });
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
  const correction = useMemo(() => {
    const heights = resolveNativeStickyHeights({
      layoutHeight: layout?.height ?? 0,
      body: body?.channel === channel ? body.geometry : null,
    });
    if (!enabled || !layout || !heights) return zero;
    const original = scrollAnimatedValue.interpolate(
      nativeStickyInterpolation(layout.y, heights.flowHeight, next),
    );
    const visible = scrollAnimatedValue.interpolate(
      nativeStickyInterpolation(layout.y, heights.pinnedHeight, next),
    );
    return Animated.subtract(visible, original);
  }, [enabled, layout, body, channel, next, scrollAnimatedValue, zero]);
  const correctionStyle = useMemo(
    () => ({ transform: [{ translateY: correction }], overflow: "visible" as const }),
    [correction],
  );
  const content = (
    <NativeStickyLayoutContext.Provider value={channel}>
      {cloneElement(props.children, { onLayout: undefined })}
    </NativeStickyLayoutContext.Provider>
  );
  return (
    <RNStickyHeader
      {...props}
      ref={inner}
      onLayout={onLayout}
      scrollAnimatedValue={scrollAnimatedValue}
    >
      <View
        style={[
          props.children.props.style,
          { overflow: "visible", pointerEvents: enabled ? "box-none" : undefined },
        ]}
        pointerEvents={enabled ? "box-none" : undefined}
        onLayout={props.children.props.onLayout}
        collapsable={false}
      >
        {enabled ? (
          <Animated.View style={correctionStyle} pointerEvents="box-none" collapsable={false}>
            {content}
          </Animated.View>
        ) : (
          content
        )}
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
