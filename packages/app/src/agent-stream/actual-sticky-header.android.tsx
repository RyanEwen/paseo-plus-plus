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
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { StyleSheet, type LayoutChangeEvent } from "react-native";
import Animated, {
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  useDerivedValue,
  type SharedValue,
} from "react-native-reanimated";
import { scheduleOnRN, scheduleOnUI } from "react-native-worklets";
import {
  KeyboardDockDisplacementContext,
  useKeyboardDockDisplacement,
} from "@/keyboard/shift/internal/dock-displacement.android";
import { useNativeStickyViewport } from "./native-sticky-viewport";
import {
  nativeStickyRowOwnsEdge,
  nativeStickySuccessorOwnsEdge,
  nativeStickyPresentationStyle,
  type NativeStickyGeometry,
} from "./native-actual-row-model";
import { ordinaryNativeMessagePresentation } from "@/components/user-message-flow-model";
import {
  NativeMessagePresentationContext,
  type NativeMessagePresentationDriver,
} from "@/components/user-message-native-presentation";
import type { NativeStickyProps } from "./native-sticky-contract";

interface NativeExpansionRetirementInput extends Pick<
  NativeMessagePresentationDriver,
  "binding" | "activeBinding" | "expanded" | "onExpandedChange"
> {
  geometry: SharedValue<NativeStickyGeometry>;
  y: SharedValue<number>;
  k: SharedValue<number>;
  topOverlayInset: number;
}

/** Retire only this row's explicit expansion when its measured successor takes over.
 * The existing presentation writer resets the held inner body before ordinary
 * paint. Reverse alone preserves the remembered preference. This reaction does
 * not subscribe to the preference it clears.
 */
function useNativeExpansionRetirement({
  binding,
  activeBinding,
  expanded,
  onExpandedChange,
  geometry,
  y,
  k,
  topOverlayInset,
}: NativeExpansionRetirementInput) {
  useAnimatedReaction(
    () => {
      const current = geometry.value.binding === binding && activeBinding.value === binding;
      return {
        takenOver: nativeStickySuccessorOwnsEdge(
          geometry.value.next,
          y.value + k.value + topOverlayInset,
        ),
        ready: geometry.value.ready && current,
      };
    },
    (boundary) => {
      if (
        !boundary.ready ||
        !boundary.takenOver ||
        activeBinding.value !== binding ||
        !expanded.value
      )
        return;
      expanded.value = false;
      scheduleOnRN(onExpandedChange, false);
    },
    [binding, activeBinding, expanded, onExpandedChange, geometry, y, k, topOverlayInset],
  );
}

/** Keep Android's physical touch bounds on the same root as sticky motion.
 * ScrollView still receives natural row layout and next-header ref updates. */
export function ActualStickyHeader({ ref, children, ...props }: NativeStickyProps) {
  const reportLayout = props.onLayout;
  const rows = useContext(ActualPromptRowsContext);
  const id = children.props.item?.id;
  const enabled = rows !== null && id !== undefined;
  const channel = useMemo(
    () =>
      createNativeStickyLayout<LayoutChangeEvent>({
        key: children.key,
        index: children.props.index,
        scope: rows?.scope,
        handoff: "full-row",
      }),
    [children.key, children.props.index, rows?.scope],
  );
  const nextBinding = useRef(0);
  const allocation = useMemo(() => ({ channel, version: ++nextBinding.current }), [channel]);
  const binding = allocation.version;
  const { y } = useNativeStickyViewport();
  const k = useKeyboardDockDisplacement();
  const topOverlayInset = useStreamTopOverlayInset();
  const [measurement, setMeasurement] = useState<{
    channel: typeof channel;
    frame: { y: number; height: number };
  } | null>(null);
  const layout = measurement?.channel === channel ? measurement.frame : null;
  const next = useRef<number | null>(props.nextHeaderLayoutY ?? null);
  const lastPropNext = useRef(props.nextHeaderLayoutY);
  const nextChannel = useRef(channel);
  const geometry = useSharedValue<NativeStickyGeometry>({
    binding,
    ready: false,
    y: 0,
    flowHeight: 0,
    next: next.current,
  });
  useLayoutEffect(() => {
    if (nextChannel.current !== channel || lastPropNext.current !== props.nextHeaderLayoutY) {
      nextChannel.current = channel;
      lastPropNext.current = props.nextHeaderLayoutY;
      next.current = props.nextHeaderLayoutY ?? null;
    }
    geometry.value = {
      binding,
      ready: layout !== null,
      y: layout?.y ?? 0,
      flowHeight: layout?.height ?? 0,
      next: next.current,
    };
  }, [props.nextHeaderLayoutY, layout, channel, binding, geometry]);
  const presentation = useSharedValue(ordinaryNativeMessagePresentation());
  const activeBinding = useSharedValue(0);
  const maximumHeight = useSharedValue(rows?.bodyViewportHeight ?? 0);
  const expanded = useSharedValue(false);
  const rememberExpanded = rows?.rememberExpanded;
  const committedChannel = useRef<typeof channel | null>(channel);
  useLayoutEffect(() => {
    committedChannel.current = channel;
    return () => {
      if (committedChannel.current === channel) committedChannel.current = null;
    };
  }, [channel]);
  const onExpandedChange = useCallback(
    (nextExpanded: boolean) => {
      if (committedChannel.current === channel && id !== undefined)
        rememberExpanded?.(id, nextExpanded);
    },
    [channel, id, rememberExpanded],
  );
  useLayoutEffect(() => {
    maximumHeight.value = rows?.bodyViewportHeight ?? 0;
  }, [maximumHeight, rows?.bodyViewportHeight]);
  const wrapperHeight = useDerivedValue(() =>
    geometry.value.binding === binding ? geometry.value.flowHeight : 0,
  );
  const handoff = useDerivedValue(() => {
    const g = geometry.value;
    return (
      enabled &&
      g.binding === binding &&
      nativeStickyRowOwnsEdge(g, y.value + k.value + topOverlayInset)
    );
  });
  useNativeExpansionRetirement({
    binding,
    activeBinding,
    expanded,
    onExpandedChange,
    geometry,
    y,
    k,
    topOverlayInset,
  });
  const driver = useMemo(
    () => ({
      binding,
      activeBinding,
      handoff,
      presentation,
      maximumHeight,
      wrapperHeight,
      expanded,
      onExpandedChange,
    }),
    [
      binding,
      activeBinding,
      handoff,
      presentation,
      maximumHeight,
      wrapperHeight,
      expanded,
      onExpandedChange,
    ],
  );
  const initialExpanded = useRef(false);
  initialExpanded.current = id !== undefined && (rows?.expandedIds.has(id) ?? false);
  useLayoutEffect(() => {
    const preference = initialExpanded.current;
    scheduleOnUI(() => {
      "worklet";
      expanded.value = preference;
      activeBinding.value = binding;
    });
  }, [binding, activeBinding, expanded]);
  const registerNativeExpansion = rows?.registerNativeExpansion;
  useLayoutEffect(() => {
    if (id === undefined || !registerNativeExpansion) return;
    return registerNativeExpansion(id, () => {
      scheduleOnUI(() => {
        "worklet";
        if (activeBinding.value === binding) expanded.value = true;
      });
    });
  }, [id, registerNativeExpansion, activeBinding, binding, expanded]);
  useImperativeHandle(
    ref,
    () => ({
      setNextHeaderY(value) {
        next.current = value;
        geometry.value = { ...geometry.value, next: value };
      },
    }),
    [geometry],
  );
  const originalLayout = children.props.onLayout;
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      setMeasurement({ channel, frame: event.nativeEvent.layout });
      reportLayout(event);
      event.persist();
      channel.publish(event);
      originalLayout?.(event);
    },
    [reportLayout, channel, originalLayout],
  );
  const style = useAnimatedStyle(() =>
    nativeStickyPresentationStyle({
      enabled,
      binding,
      activeBinding: activeBinding.value,
      geometry: geometry.value,
      presentation: presentation.value,
      leading: y.value + k.value + topOverlayInset,
    }),
  );
  return (
    <Animated.View
      nativeID={props.nativeID}
      style={[children.props.style, style]}
      pointerEvents={enabled ? "box-none" : undefined}
      onLayout={onLayout}
      collapsable={false}
    >
      <NativeStickyLayoutContext.Provider value={channel}>
        <NativeMessagePresentationContext.Provider value={enabled ? driver : null}>
          {cloneElement(children, { onLayout: undefined, style: styles.fill })}
        </NativeMessagePresentationContext.Provider>
      </NativeStickyLayoutContext.Provider>
    </Animated.View>
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
  const zero = useSharedValue(0);
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

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
