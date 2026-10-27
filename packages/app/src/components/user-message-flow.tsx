import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
  type ComponentRef,
} from "react";
import {
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
  type ViewProps,
  type ScrollView as NativeScrollView,
} from "react-native";
import { ScrollView } from "./ui/scroll-view";
import { StyleSheet } from "react-native-unistyles";
import type { NativeMessagePresentationDriver } from "./user-message-native-presentation";
import {
  resolveMessageFlow,
  readMessageTextLayout,
  rebindMessageTextPrefix,
  type MessageFlowFrame,
  type MessageFlowMeasurements,
  type MessageTextPrefix,
  type NaturalTextLine,
  type NaturalMessageGeometry,
} from "./user-message-flow-model";

export type { NaturalMessageGeometry } from "./user-message-flow-model";

type FrameName = "bubble" | "content" | "text" | "controls";
type Measurable = ComponentRef<typeof View>;

export interface MessageFlowContext {
  /** Only the explicitly opted-in Android owner supplies a native presentation. */
  nativePresentation?: NativeMessagePresentationDriver;
  compact: boolean;
  /** The web adapter preserves its existing inner padding cell and visual bubble. */
  web?: boolean;
  /** Current measured reading rail, independent of compact paint or preparation. */
  webRailWidth?: number;
  /** Prepared web paint moves vertical chrome inside the visual bubble. */
  webContentPadding?: boolean;
  bubbleHeight?: number;
  contentWidth?: number;
  registerAttachments?(node: Measurable | null): void;
  bubbleWidth: number | undefined;
  textWidth: number | undefined;
  /** Web keeps the real Text's current full layout outside its clipped prefix. */
  textHeight?: number;
  /** Only the web adapter clips TextPreview itself; native keeps its current paint owner. */
  clipText?: boolean;
  textClipWidth: number | undefined;
  /** Actual first-line paint boundary; absent outside qualified compact mode. */
  textPrefixHeight: number | undefined;
  textTranslateX: number;
  textTranslateY: number;
  register(name: FrameName, node: Measurable | null): void;
  reportFrame(name: FrameName, event: LayoutChangeEvent): void;
  reportText(lines: readonly NaturalTextLine[]): void;
}

export const NaturalMessageFlowContext = createContext<MessageFlowContext | null>(null);

interface NaturalMessageBubbleProps extends ViewProps {
  ref?: Ref<Measurable>;
}

/** Compose the existing source bubble ref with its natural-layout owner. */
export function NaturalMessageBubble({
  ref,
  onLayout,
  style,
  ...props
}: NaturalMessageBubbleProps) {
  const flow = useContext(NaturalMessageFlowContext);
  const register = useCallback(
    (node: Measurable | null) => {
      flow?.register("bubble", node);
      if (typeof ref === "function") {
        const cleanup = ref(node);
        if (node) {
          return () => {
            flow?.register("bubble", null);
            if (typeof cleanup === "function") cleanup();
            else ref(null);
          };
        }
      } else if (ref) {
        ref.current = node;
      }
    },
    [flow, ref],
  );
  const reportLayout = useCallback(
    (event: LayoutChangeEvent) => {
      flow?.reportFrame("bubble", event);
      onLayout?.(event);
    },
    [flow, onLayout],
  );
  return (
    <View
      {...props}
      ref={register}
      onLayout={reportLayout}
      style={[
        style,
        flow?.bubbleWidth === undefined ? undefined : { width: flow.bubbleWidth },
        flow?.bubbleHeight === undefined ? undefined : { height: flow.bubbleHeight },
        flow?.webContentPadding ? { paddingTop: 0, paddingBottom: 0 } : undefined,
      ]}
      collapsable={false}
    />
  );
}

export interface UserMessageFlowProps {
  driver?: NativeMessagePresentationDriver | null;
  children: ReactNode;
  trailing: ReactNode;
  controls: ReactNode;
  summary: ReactNode;
  revision: object;
  message: string;
  compact: boolean;
  bounded: boolean;
  maximumHeight: number | undefined;
  backdropStyle: StyleProp<ViewStyle>;
  /** Non-interactive absolute-fill background for the measured visible column. */
  visualBackdrop?: ReactNode;
  onGeometry(geometry: NaturalMessageGeometry | null): void;
  /** Web reports actual pointer presence without owning message action policy. */
  onHoverChange?(hovered: boolean): void;
}

function emptyMeasurements(width: number): MessageFlowMeasurements {
  return {
    width,
    bodyHeight: null,
    trailingHeight: null,
    bubble: null,
    content: null,
    text: null,
    prefixHeight: null,
    controls: null,
  };
}

function sameFrame(left: MessageFlowFrame | null, right: MessageFlowFrame): boolean {
  return (
    left !== null &&
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

/** Rebind natural measurements when content, available width or font geometry changes. */
export function useNaturalMessageMeasurements(
  props: Pick<UserMessageFlowProps, "revision" | "message" | "bounded">,
) {
  const { fontScale } = useWindowDimensions();
  const [width, setWidth] = useState(0);
  const [fontRevision, setFontRevision] = useState(0);
  const invalidateMeasurements = useCallback(() => setFontRevision((revision) => revision + 1), []);
  const key = useMemo(
    () => ({ revision: props.revision, width, fontScale, fontRevision }),
    [props.revision, width, fontScale, fontRevision],
  );
  const currentKey = useRef(key);
  const frames = useRef(new Map<FrameName, Measurable>());
  const body = useRef<Measurable>(null);
  const trailing = useRef<Measurable>(null);
  const prefix = useRef<MessageTextPrefix | null>(null);
  const textFrame = useRef<{ key: object; width: number } | null>(null);
  const [state, setState] = useState(() => ({ key, metrics: emptyMeasurements(width) }));
  const metrics = state.key === key ? state.metrics : emptyMeasurements(width);

  const update = useCallback(
    (change: (current: MessageFlowMeasurements) => MessageFlowMeasurements) => {
      if (currentKey.current !== key) return;
      setState((current) => {
        if (currentKey.current !== key) return current;
        const previous = current.key === key ? current.metrics : emptyMeasurements(width);
        const next = change(previous);
        return current.key === key && next === previous ? current : { key, metrics: next };
      });
    },
    [key, width],
  );
  const reportFrame = useCallback(
    (name: FrameName, frame: MessageFlowFrame) => {
      if (currentKey.current !== key) return;
      if (name === "text") textFrame.current = { key, width: frame.width };
      const currentPrefix =
        name === "text"
          ? rebindMessageTextPrefix({
              prefix: prefix.current,
              binding: { key, message: props.message, fontScale, width: frame.width },
            })
          : null;
      if (currentPrefix) prefix.current = currentPrefix;
      update((current) => {
        // A fresh frame can revalidate unchanged natural Text metrics after an
        // attachment or font-shape revision. A width mismatch invalidates them.
        const prefixHeight =
          name === "text" ? (currentPrefix?.height ?? null) : current.prefixHeight;
        if (sameFrame(current[name], frame) && prefixHeight === current.prefixHeight)
          return current;
        return { ...current, [name]: frame, prefixHeight };
      });
    },
    [update, key, props.message, fontScale],
  );
  const reportHeight = useCallback(
    (name: "bodyHeight" | "trailingHeight", height: number) => {
      update((current) => (current[name] === height ? current : { ...current, [name]: height }));
    },
    [update],
  );
  const reportText = useCallback(
    (lines: readonly NaturalTextLine[]) => {
      if (currentKey.current !== key) return;
      // Theme fonts can change without changing the system font scale. A fresh
      // natural line shape invalidates the pinned width, then ordinary layout
      // establishes its replacement. Disclosure never changes these full lines.
      const result = readMessageTextLayout({
        binding: {
          key,
          message: props.message,
          fontScale,
          width: textFrame.current?.key === key ? textFrame.current.width : null,
        },
        previous: prefix.current,
        lines,
        bounded: props.bounded,
      });
      // Preserve this event before rebinding. At unchanged width, RN need not
      // emit another Text event after we restore the ordinary body for measuring.
      prefix.current = result.prefix;
      if (result.rebind) {
        setFontRevision((revision) => revision + 1);
        return;
      }
      const height = result.prefix.height;
      update((current) => {
        return current.prefixHeight === height ? current : { ...current, prefixHeight: height };
      });
    },
    [update, key, props.message, props.bounded, fontScale],
  );

  // Layout callbacks also cover intrinsic attachment and theme changes. Explicit
  // reads on a binding revision refresh unchanged chrome whose onLayout need not
  // fire again. These are layout-bound reads, never per-scroll measurements.
  useLayoutEffect(() => {
    currentKey.current = key;
    for (const [name, node] of frames.current) {
      node.measure((x, y, measuredWidth, height) => {
        reportFrame(name, { x, y, width: measuredWidth, height });
      });
    }
    body.current?.measure((_x, _y, _width, height) => reportHeight("bodyHeight", height));
    trailing.current?.measure((_x, _y, _width, height) => reportHeight("trailingHeight", height));
  }, [key, reportFrame, reportHeight]);

  return {
    key,
    currentKey,
    width,
    setWidth,
    metrics,
    frames,
    body,
    trailing,
    reportFrame,
    reportHeight,
    reportText,
    invalidateMeasurements,
  };
}

interface MessageBodyCapInput {
  maximumHeight: number | undefined;
  trailingHeight: number | null;
  controlsHeight: number | undefined;
  controlsInFlow: boolean;
}

/** Leave measured ordinary actions and expanded disclosure outside the body viewport. */
function messageBodyViewportCap({
  maximumHeight,
  trailingHeight,
  controlsHeight,
  controlsInFlow,
}: MessageBodyCapInput): number {
  const trailing = trailingHeight ?? 0;
  const controls = controlsInFlow ? (controlsHeight ?? 0) : 0;
  return Math.max(0, (maximumHeight ?? Infinity) - trailing - controls);
}

/** Keep one full ordinary body measuring while only its visible viewport changes.
 * The transparent flow reservation contains no second message or touch surface.
 * Incomplete or rebound measurements render ordinary content until current layout
 * establishes both the natural body and its ordinary trailing/action extent.
 */
export function UserMessageFlow(props: UserMessageFlowProps) {
  const { onGeometry } = props;
  const {
    key,
    currentKey,
    width,
    setWidth,
    metrics,
    frames,
    body,
    trailing,
    reportFrame,
    reportHeight,
    reportText,
  } = useNaturalMessageMeasurements(props);
  const visual = useRef<Measurable>(null);
  const viewport = useRef<NativeScrollView>(null);

  const hasText = props.message.trim().length > 0;
  const flow = resolveMessageFlow({ measurements: metrics, hasText });
  const compact = props.compact && flow !== null;
  const bounded = props.bounded && flow !== null;
  const wasBounded = useRef(props.bounded);
  useLayoutEffect(() => {
    // The message's inner viewport may have scrolled during More. Collapsing
    // or unpinning restores its origin without depending on a native range clamp.
    // This moves only the inner body, never the transcript or the Text owner.
    const becameOrdinary = wasBounded.current && !props.bounded;
    wasBounded.current = props.bounded;
    if (compact || becameOrdinary) viewport.current?.scrollTo({ y: 0, animated: false });
  }, [compact, props.bounded]);
  const controlsInFlow = bounded && !compact;
  const cap = messageBodyViewportCap({
    maximumHeight: props.maximumHeight,
    trailingHeight: metrics.trailingHeight,
    controlsHeight: metrics.controls?.height,
    controlsInFlow,
  });
  const viewportHeight = compact ? Math.min(flow.compactHeight, cap) : undefined;
  const visualKey = useMemo(
    () => ({ key, compact, bounded, viewportHeight, cap }),
    [key, compact, bounded, viewportHeight, cap],
  );
  const currentVisualKey = useRef(visualKey);
  const [visualState, setVisualState] = useState<{ key: object; height: number } | null>(null);
  const reportVisual = useCallback(
    (height: number) => {
      if (currentKey.current !== key || currentVisualKey.current !== visualKey) return;
      setVisualState((current) =>
        current?.key === visualKey && current.height === height
          ? current
          : { key: visualKey, height },
      );
    },
    [key, visualKey, currentKey],
  );
  useLayoutEffect(() => {
    currentVisualKey.current = visualKey;
    onGeometry(null);
    visual.current?.measure((_x, _y, _width, height) => reportVisual(height));
    return () => onGeometry(null);
  }, [visualKey, reportVisual, onGeometry]);
  const flowHeight = flow?.flowHeight;
  useLayoutEffect(() => {
    if (flowHeight === undefined || visualState?.key !== visualKey) return;
    onGeometry({ flowHeight, visualHeight: visualState.height });
  }, [flowHeight, visualState, visualKey, onGeometry]);

  const context = useMemo<MessageFlowContext>(
    () => ({
      compact,
      bubbleWidth: bounded ? flow?.bubbleWidth : undefined,
      textWidth: compact ? flow.textWidth : undefined,
      textClipWidth: compact ? flow.textClipWidth : undefined,
      textPrefixHeight: compact ? (metrics.prefixHeight ?? undefined) : undefined,
      textTranslateX: compact ? flow.textTranslateX : 0,
      textTranslateY: compact ? flow.textTranslateY : 0,
      register(name, node) {
        if (node) frames.current.set(name, node);
        else frames.current.delete(name);
      },
      reportFrame(name, event) {
        reportFrame(name, event.nativeEvent.layout);
      },
      reportText,
    }),
    [compact, bounded, flow, metrics.prefixHeight, frames, reportFrame, reportText],
  );
  const controlStyle = useMemo(
    () => [
      styles.controls,
      controlsInFlow ? styles.controlsInFlow : styles.controlsOverlay,
      !bounded && styles.hidden,
      compact && { top: metrics.content?.y ?? 0, right: metrics.content?.x ?? 0 },
      {
        maxWidth: Math.max(0, width - (metrics.content?.x ?? 0) * 2),
      },
    ],
    [controlsInFlow, bounded, compact, metrics.content, width],
  );
  const bodyScrollable = bounded && !compact;
  const dataSet = useMemo(() => ({ bodyExpanded: String(!compact) }), [compact]);
  const measureRail = useCallback(
    (event: LayoutChangeEvent) => {
      setWidth(event.nativeEvent.layout.width);
    },
    [setWidth],
  );
  const measureVisual = useCallback(
    (event: LayoutChangeEvent) => {
      reportVisual(event.nativeEvent.layout.height);
    },
    [reportVisual],
  );
  const measureBody = useCallback(
    (event: LayoutChangeEvent) => {
      reportHeight("bodyHeight", event.nativeEvent.layout.height);
    },
    [reportHeight],
  );
  const measureTrailing = useCallback(
    (event: LayoutChangeEvent) => {
      reportHeight("trailingHeight", event.nativeEvent.layout.height);
    },
    [reportHeight],
  );
  const registerControls = useCallback(
    (node: Measurable | null) => {
      context.register("controls", node);
    },
    [context],
  );
  const measureControls = useCallback(
    (event: LayoutChangeEvent) => {
      context.reportFrame("controls", event);
    },
    [context],
  );
  return (
    <NaturalMessageFlowContext.Provider value={context}>
      <View
        style={[styles.flow, flow && { height: flow.flowHeight }]}
        pointerEvents="box-none"
        onLayout={measureRail}
      >
        <View ref={visual} style={styles.visual} pointerEvents="box-none" onLayout={measureVisual}>
          {/* Back only the measured visible column, including disclosure and action
              spacing. The remaining full-flow reservation stays transparent. */}
          {bounded ? props.visualBackdrop : null}
          <View style={styles.viewport} pointerEvents="box-none">
            {compact ? (
              <View
                style={[StyleSheet.absoluteFill, props.backdropStyle]}
                pointerEvents="none"
                accessible={false}
              />
            ) : null}
            <ScrollView
              ref={viewport}
              style={[
                styles.bodyViewport,
                bounded && { maxHeight: cap },
                compact && { height: viewportHeight },
              ]}
              scrollEnabled={bodyScrollable}
              nestedScrollEnabled={bodyScrollable}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={bodyScrollable}
              testID="user-message-body-scroll"
              dataSet={dataSet}
            >
              <View ref={body} style={styles.body} collapsable={false} onLayout={measureBody}>
                {props.children}
              </View>
            </ScrollView>
            <View
              style={controlStyle}
              pointerEvents={bounded ? "auto" : "none"}
              accessibilityElementsHidden={!bounded}
              importantForAccessibility={bounded ? "auto" : "no-hide-descendants"}
              aria-hidden={!bounded}
              ref={registerControls}
              onLayout={measureControls}
              collapsable={false}
            >
              {props.compact ? props.summary : null}
              {props.controls}
            </View>
          </View>
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

const styles = StyleSheet.create((theme) => ({
  flow: { width: "100%", minWidth: 0, flexShrink: 1, overflow: "visible" },
  visual: { width: "100%", flexShrink: 0, alignItems: "flex-end", overflow: "visible" },
  viewport: { width: "100%", flexShrink: 0 },
  bodyViewport: { flexGrow: 0, flexShrink: 0 },
  body: { width: "100%", alignItems: "flex-end", flexShrink: 0 },
  controls: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  controlsOverlay: { position: "absolute", top: 0 },
  controlsInFlow: { alignSelf: "flex-end", marginHorizontal: theme.spacing[4] },
  hidden: { opacity: 0 },
}));
