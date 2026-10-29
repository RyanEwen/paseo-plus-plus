import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type ComponentRef,
} from "react";
import {
  View,
  StyleSheet,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Animated, {
  createAnimatedComponent,
  scrollTo,
  useAnimatedProps,
  useAnimatedReaction,
  useAnimatedRef,
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
  type AnimatedRef,
} from "react-native-reanimated";
import { scheduleOnRN, scheduleOnUI } from "react-native-worklets";
import { ScrollView } from "./ui/scroll-view";
import {
  NaturalMessageFlowContext,
  useNaturalMessageMeasurements,
  type MessageFlowContext,
  type UserMessageFlowProps,
} from "./user-message-flow";
import {
  advanceNativeMessagePresentation,
  acceptsNativeMessageDisclosure,
  nativeMessageRoleVisible,
  nativeMessageViewportGeometry,
  resolveMessageFlow,
  bindNativeMessagePreparation,
  type NativeMessagePreparation,
  type NativeMessagePreparationBinding,
} from "./user-message-flow-model";
import {
  NativeMessageDisclosureAuthorityContext,
  type NativeMessageDisclosureRequest,
  type NativeMessagePresentationDriver,
} from "./user-message-native-presentation";
import { resolveHighlightCorners } from "./ui/press-highlight.shape";

const AnimatedScrollView = createAnimatedComponent(ScrollView);

interface NativeMessageVisibilityProps {
  driver: NativeMessagePresentationDriver;
  visible: "compact" | "expanded" | "body" | "pinned";
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}

interface NativeMessageTextPaintProps {
  driver: NativeMessagePresentationDriver;
  children: ReactNode;
}

interface NativeMessageSuffixMaskProps {
  driver: NativeMessagePresentationDriver;
  backgroundStyle: StyleProp<ViewStyle>;
}

interface NativeMessageDisclosureSlotProps {
  driver: NativeMessagePresentationDriver;
  more: ReactNode;
  less: ReactNode;
}

/** This boundary is reached only by the explicitly opted-in renderer. */
function nativePresentationDriver(props: UserMessageFlowProps): NativeMessagePresentationDriver {
  if (!props.driver) throw new Error("Native message flow requires its presentation owner");
  return props.driver;
}

/** Native-only gate for prepared chrome or real attachment controls. Opacity alone
 * must never leave hidden controls hit-testable or in the accessibility tree.
 */
export function NativeMessageVisibility({
  driver,
  visible,
  children,
  style: outerStyle,
}: NativeMessageVisibilityProps) {
  const props = useAnimatedProps(() => {
    const mode = driver.presentation.value.mode;
    const shown = nativeMessageRoleVisible(mode, visible);
    return {
      pointerEvents: shown ? ("box-none" as const) : ("none" as const),
      accessibilityElementsHidden: !shown,
      importantForAccessibility: shown ? ("auto" as const) : ("no-hide-descendants" as const),
    };
  });
  const style = useAnimatedStyle(() => {
    const mode = driver.presentation.value.mode;
    const shown = nativeMessageRoleVisible(mode, visible);
    return { opacity: shown ? 1 : 0 };
  });
  return (
    <Animated.View animatedProps={props} style={[outerStyle, style]}>
      {children}
    </Animated.View>
  );
}

/** Clip/translate paint without changing the single Text's ordinary wrapping. */
export function NativeMessageTextPaint({ driver, children }: NativeMessageTextPaintProps) {
  const style = useAnimatedStyle(() => {
    const frame = driver.presentation.value;
    return {
      width: frame.textClipWidth,
      overflow: frame.mode === "compact" ? ("hidden" as const) : ("visible" as const),
      transform: [{ translateX: frame.textTranslateX }, { translateY: frame.textTranslateY }],
    };
  });
  return <Animated.View style={style}>{children}</Animated.View>;
}

/** The suffix mask shares the handoff mode, including reverse before React runs. */
export function NativeMessageSuffixMask({ driver, backgroundStyle }: NativeMessageSuffixMaskProps) {
  const style = useAnimatedStyle(() => ({
    opacity: driver.presentation.value.mode === "compact" ? 1 : 0,
    top: driver.presentation.value.prefixHeight,
  }));
  return (
    <Animated.View
      style={[styles.suffix, style]}
      pointerEvents="none"
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
    >
      <View style={[StyleSheet.absoluteFill, backgroundStyle]} pointerEvents="none" />
    </Animated.View>
  );
}

/** A queued JS activation must still own this native handoff before changing it. */
export function requestNativeMessageDisclosure(
  driver: NativeMessagePresentationDriver,
  request: NativeMessageDisclosureRequest,
) {
  scheduleOnUI(() => {
    "worklet";
    if (driver.binding !== driver.activeBinding.value) return;
    if (!driver.handoff.value) return;
    const frame = driver.presentation.value;
    if (frame.binding !== driver.binding) return;
    if (!acceptsNativeMessageDisclosure(frame, request.revision, request.cycle, request.expected))
      return;
    if (driver.expanded.value === request.expanded) return;
    driver.expanded.value = request.expanded;
    scheduleOnRN(driver.onExpandedChange, request.expanded);
  });
}

/** Keep More and Less measured without mounting another USER or waiting for JS
 * to replace a label during a native reverse handoff. Only one control is active.
 */
export function NativeMessageDisclosureSlot({
  driver,
  more,
  less,
}: NativeMessageDisclosureSlotProps) {
  const [authority, setAuthority] = useState({ revision: 0, cycle: 0 });
  const publishAuthority = useCallback((revision: number, cycle: number) => {
    setAuthority((current) =>
      current.revision === revision && current.cycle === cycle ? current : { revision, cycle },
    );
  }, []);
  useAnimatedReaction(
    () => ({
      revision: driver.presentation.value.revision,
      cycle: driver.presentation.value.cycle,
    }),
    (value, previous) => {
      if (value.revision !== previous?.revision || value.cycle !== previous?.cycle) {
        scheduleOnRN(publishAuthority, value.revision, value.cycle);
      }
    },
    [driver, publishAuthority],
  );
  const [sizes, setSizes] = useState({
    more: { width: 0, height: 0 },
    less: { width: 0, height: 0 },
  });
  const report = useCallback((name: "more" | "less", event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSizes((current) =>
      current[name].width === width && current[name].height === height
        ? current
        : { ...current, [name]: { width, height } },
    );
  }, []);
  const reportMore = useCallback((event: LayoutChangeEvent) => report("more", event), [report]);
  const reportLess = useCallback((event: LayoutChangeEvent) => report("less", event), [report]);
  const size = {
    width: Math.max(sizes.more.width, sizes.less.width),
    height: Math.max(sizes.more.height, sizes.less.height),
  };
  return (
    <NativeMessageDisclosureAuthorityContext.Provider value={authority}>
      <View style={size.width > 0 && size.height > 0 ? size : undefined}>
        <View onLayout={reportMore}>
          <NativeMessageVisibility driver={driver} visible="compact">
            {more}
          </NativeMessageVisibility>
        </View>
        <View style={styles.alternateControl} onLayout={reportLess}>
          <NativeMessageVisibility driver={driver} visible="expanded">
            {less}
          </NativeMessageVisibility>
        </View>
      </View>
    </NativeMessageDisclosureAuthorityContext.Provider>
  );
}

type NaturalMeasurements = ReturnType<typeof useNaturalMessageMeasurements>;
type NativeBodyViewport = ComponentRef<typeof ScrollView>;

interface NativeMessageViewportAttachment {
  key: object;
  node: NativeBodyViewport;
}

interface NativeViewportBinding {
  viewport: AnimatedRef<NativeBodyViewport>;
  bindViewport(node: NativeBodyViewport | null): void;
  active: SharedValue<boolean>;
  available: SharedValue<boolean>;
}

/** The mounted body owns its held native instance across styling ref cycles.
 * Effect replay reactivates that same instance without waiting for new layout.
 */
function useNativeMessageViewport(
  m: NaturalMeasurements,
  prepared: SharedValue<NativeMessagePreparation | null>,
): NativeViewportBinding {
  const { key, currentKey, invalidateMeasurements } = m;
  const viewport = useAnimatedRef<ComponentRef<typeof ScrollView>>();
  const heldViewport = useRef<ComponentRef<typeof ScrollView> | null>(null);
  const pending = useRef<NativeMessageViewportAttachment | null>(null);
  const active = useSharedValue(false);
  const available = useSharedValue(false);
  const publish = useCallback(
    (node: ComponentRef<typeof ScrollView>) => {
      if (heldViewport.current !== null && heldViewport.current !== node) {
        prepared.value = null;
        invalidateMeasurements();
      }
      heldViewport.current = node;
      viewport(node);
      available.value = true;
    },
    [viewport, prepared, invalidateMeasurements, available],
  );
  const bindViewport = useCallback(
    (node: ComponentRef<typeof ScrollView> | null) => {
      if (!node) return;
      pending.current = { key, node };
      if (currentKey.current === key) publish(node);
    },
    [currentKey, key, publish],
  );
  useLayoutEffect(() => {
    active.value = true;
    const next = pending.current;
    const held = next?.key === key ? next.node : heldViewport.current;
    if (held) publish(held);
    return () => {
      active.value = false;
      available.value = false;
    };
  }, [key, active, available, publish]);
  return { viewport, bindViewport, active, available };
}

/** Publish an all-or-nothing natural snapshot. UI caps are applied by the consumer,
 * so a changing keyboard viewport never rebinds the natural Text measurements.
 */
function usePreparedNativeMessage(
  m: NaturalMeasurements,
  flow: ReturnType<typeof resolveMessageFlow>,
  requiresControls: boolean,
) {
  const { key, metrics, currentKey } = m;
  const prepared = useSharedValue<NativeMessagePreparation | null>(null);
  const previous = useRef<NativeMessagePreparationBinding | null>(null);
  useLayoutEffect(() => {
    if (currentKey.current !== key) {
      prepared.value = null;
      return;
    }
    const next = bindNativeMessagePreparation({
      key,
      previous: previous.current,
      measurements: metrics,
      flow,
      requiresControls,
    });
    previous.current = next;
    prepared.value = next.value;
    return () => {
      prepared.value = null;
    };
  }, [key, currentKey, metrics, flow, prepared, requiresControls]);
  return prepared;
}

interface NativeProjectionInput {
  driver: NativeMessagePresentationDriver;
  prepared: SharedValue<NativeMessagePreparation | null>;
  binding: NativeViewportBinding;
  publishGeometry(naturalHeight: number, visualHeight: number): void;
}

/** This UI reaction is the sole mode writer. The synchronous reset runs before
 * the new mode becomes visible to wrapper motion, paint and native prop gates.
 */
function useNativeMessageProjection({
  driver,
  prepared,
  binding,
  publishGeometry,
}: NativeProjectionInput) {
  const { viewport, active, available } = binding;
  // Capturing the driver would subscribe this writer to its own presentation output.
  const {
    binding: presentationBinding,
    activeBinding,
    handoff,
    expanded,
    maximumHeight,
    wrapperHeight,
  } = driver;
  useAnimatedReaction(
    () => ({
      prepared: prepared.value,
      eligible: handoff.value,
      expanded: expanded.value,
      active: active.value && available.value && presentationBinding === activeBinding.value,
      maximum: maximumHeight.value,
      wrapperHeight: wrapperHeight.value,
    }),
    (input) => {
      // An inactive body has no new paint to publish. In particular, never
      // dispatch a reset to a departing native view during owner cleanup.
      if (driver.binding !== driver.activeBinding.value || !input.active) return;
      const current = input.active ? input.prepared : null;
      const value = current ? { ...current, maximumHeight: input.maximum } : null;
      const eligible =
        input.active && input.eligible && value !== null && input.wrapperHeight >= value.flowHeight;
      driver.presentation.value = advanceNativeMessagePresentation({
        binding: driver.binding,
        previous: driver.presentation.value,
        prepared: value,
        eligible,
        expanded: input.expanded,
        resetBody() {
          "worklet";
          if (!viewport())
            throw new Error("Current natural message viewport is unavailable for reset");
          scrollTo(viewport, 0, 0, false);
        },
      });
    },
    [driver, viewport],
  );
  useAnimatedReaction(
    () => ({ frame: driver.presentation.value, naturalHeight: prepared.value?.flowHeight ?? 0 }),
    (input, previous) => {
      const height =
        input.frame.mode === "ordinary" ? input.naturalHeight : input.frame.visualHeight;
      const previousHeight =
        previous?.frame.mode === "ordinary" ? previous.naturalHeight : previous?.frame.visualHeight;
      if (
        input.naturalHeight > 0 &&
        (input.naturalHeight !== previous?.naturalHeight || height !== previousHeight)
      ) {
        scheduleOnRN(publishGeometry, input.naturalHeight, height);
      }
    },
    [driver, publishGeometry],
  );
}

/** Native paint consumes complete ordinary measurements; the old iOS renderer
 * continues to use UserMessageFlow. No React pinned flag enters this component.
 */
export function NativeUserMessageFlow(props: UserMessageFlowProps) {
  const driver = nativePresentationDriver(props);
  const { onGeometry } = props;
  // Disclosure chrome and driver objects can change without changing the natural body.
  const revision = useMemo(
    () => ({ content: props.revision, binding: driver.binding }),
    [props.revision, driver.binding],
  );
  const measurements = useNaturalMessageMeasurements({ ...props, revision, bounded: true });
  const {
    key,
    currentKey,
    setWidth,
    metrics,
    frames,
    body,
    trailing,
    reportFrame,
    reportHeight,
    reportText,
  } = measurements;
  const hasText = props.message.trim().length > 0;
  const flow = useMemo(
    () => resolveMessageFlow({ measurements: metrics, hasText }),
    [metrics, hasText],
  );
  const prepared = usePreparedNativeMessage(measurements, flow, props.controls !== null);
  const binding = useNativeMessageViewport(measurements, prepared);
  const publishGeometry = useCallback(
    (naturalHeight: number, visualHeight: number) => {
      if (currentKey.current !== key) return;
      onGeometry({ flowHeight: naturalHeight, visualHeight });
    },
    [key, currentKey, onGeometry],
  );
  useNativeMessageProjection({ driver, prepared, binding, publishGeometry });
  useLayoutEffect(() => {
    onGeometry(null);
    return () => onGeometry(null);
  }, [key, onGeometry]);
  const context = useMemo<MessageFlowContext>(
    () => ({
      nativePresentation: driver,
      compact: false,
      bubbleWidth: undefined,
      textWidth: flow?.textWidth,
      textClipWidth: undefined,
      textPrefixHeight: undefined,
      textTranslateX: 0,
      textTranslateY: 0,
      register(name, node) {
        if (node) frames.current.set(name, node);
        else frames.current.delete(name);
      },
      reportFrame(name, event) {
        reportFrame(name, event.nativeEvent.layout);
      },
      reportText,
    }),
    [driver, flow?.textWidth, frames, reportFrame, reportText],
  );
  const bubble = metrics.bubble;
  const railWidth = metrics.width;
  const bubbleCorners = useMemo(
    () => resolveHighlightCorners(props.backdropStyle),
    [props.backdropStyle],
  );
  // Clip the painted host, not ScrollView's Yoga content-sizing boundary. The
  // retained body keeps its ordinary width in both compact and expanded modes.
  const bodyClipStyle = useAnimatedStyle(() => {
    const frame = driver.presentation.value;
    const geometry = nativeMessageViewportGeometry({ width: railWidth, bubble, mode: frame.mode });
    return {
      width: geometry.clipWidth,
      marginLeft: geometry.clipLeft,
      height: frame.bodyHeight,
      overflow: frame.mode === "ordinary" ? ("visible" as const) : ("hidden" as const),
    };
  });
  const bodyStyle = useAnimatedStyle(() => {
    const frame = driver.presentation.value;
    const geometry = nativeMessageViewportGeometry({ width: railWidth, bubble, mode: frame.mode });
    return { width: geometry.bodyWidth, marginLeft: geometry.bodyLeft, height: frame.bodyHeight };
  });
  const bodyProps = useAnimatedProps(() => ({
    scrollEnabled: driver.presentation.value.mode === "expanded",
    nestedScrollEnabled: driver.presentation.value.mode === "expanded",
    showsVerticalScrollIndicator: driver.presentation.value.mode === "expanded",
  }));
  const disclosureSpace = useAnimatedStyle(() => ({
    height: driver.presentation.value.disclosureHeight,
  }));
  const controlStyle = useAnimatedStyle(() => {
    const p = driver.presentation.value;
    const top =
      p.mode === "expanded" && typeof p.bodyHeight === "number" ? p.bodyHeight : p.controlsTop;
    return { top, right: p.controlsRight };
  });
  const backdropStyle = useAnimatedStyle(() => ({
    opacity: driver.presentation.value.mode === "ordinary" ? 0 : 1,
  }));
  const measureRail = useCallback(
    (event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width),
    [setWidth],
  );
  const measureBody = useCallback(
    (event: LayoutChangeEvent) => reportHeight("bodyHeight", event.nativeEvent.layout.height),
    [reportHeight],
  );
  const measureTrailing = useCallback(
    (event: LayoutChangeEvent) => reportHeight("trailingHeight", event.nativeEvent.layout.height),
    [reportHeight],
  );
  const registerControls = useCallback(
    (node: ComponentRef<typeof View> | null) => context.register("controls", node),
    [context],
  );
  const measureControls = useCallback(
    (event: LayoutChangeEvent) => context.reportFrame("controls", event),
    [context],
  );
  return (
    <NaturalMessageFlowContext.Provider value={context}>
      <View
        style={[styles.flow, flow && { height: flow.flowHeight }]}
        pointerEvents="box-none"
        onLayout={measureRail}
      >
        <View style={styles.visual} pointerEvents="box-none">
          <Animated.View
            style={[styles.bodyClip, bubbleCorners, bodyClipStyle]}
            pointerEvents="box-none"
          >
            <Animated.View
              style={[StyleSheet.absoluteFill, backdropStyle]}
              pointerEvents="none"
              accessible={false}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              <View style={[props.backdropStyle, StyleSheet.absoluteFill]} pointerEvents="none" />
            </Animated.View>
            <AnimatedScrollView
              ref={binding.bindViewport}
              style={[styles.viewport, bodyStyle]}
              animatedProps={bodyProps}
              keyboardShouldPersistTaps="handled"
              testID="user-message-body-scroll"
            >
              <View ref={body} style={styles.body} collapsable={false} onLayout={measureBody}>
                {props.children}
              </View>
            </AnimatedScrollView>
          </Animated.View>
          <Animated.View style={disclosureSpace} pointerEvents="none" accessible={false} />
          <Animated.View style={[styles.controls, controlStyle]} pointerEvents="box-none">
            <View
              ref={registerControls}
              onLayout={measureControls}
              style={styles.controlsRow}
              collapsable={false}
            >
              {props.summary ? (
                <NativeMessageVisibility driver={driver} visible="compact" style={styles.summary}>
                  {props.summary}
                </NativeMessageVisibility>
              ) : null}
              {props.controls}
            </View>
          </Animated.View>
          <View
            ref={trailing}
            pointerEvents="box-none"
            collapsable={false}
            onLayout={measureTrailing}
          >
            {props.trailing}
          </View>
        </View>
      </View>
    </NaturalMessageFlowContext.Provider>
  );
}

const styles = StyleSheet.create({
  flow: { width: "100%", minWidth: 0, flexShrink: 1, overflow: "visible" },
  visual: { width: "100%", flexShrink: 0, alignItems: "flex-end", overflow: "visible" },
  bodyClip: { alignSelf: "flex-start", flexShrink: 0 },
  // Preserve ScrollView content sizing; Android still clips the viewport by default.
  viewport: { width: "100%", flexGrow: 0, flexShrink: 0 },
  body: { width: "100%", alignItems: "flex-end", flexShrink: 0 },
  controls: { position: "absolute", left: 0 },
  controlsRow: {
    alignSelf: "flex-end",
    flexDirection: "row",
    alignItems: "center",
    maxWidth: "100%",
    minWidth: 0,
  },
  summary: { flexShrink: 1, minWidth: 0 },
  alternateControl: { position: "absolute", top: 0, right: 0 },
  suffix: { position: "absolute", left: 0, right: 0, bottom: 0 },
});
