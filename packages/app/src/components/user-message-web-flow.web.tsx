import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ComponentRef,
  type CSSProperties,
} from "react";
import {
  View,
  type ScrollView as NativeScrollView,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ScrollView } from "./ui/scroll-view";
import { CONTROL_HEIGHTS } from "./ui/control-geometry";
import { SPACING } from "@/styles/theme";
import {
  NaturalMessageFlowContext,
  type MessageFlowContext,
  type UserMessageFlowProps,
} from "./user-message-flow";
import { resolveMessageFlow } from "./user-message-flow-model";
import { useWebMessageMeasurements } from "./user-message-flow-measurements.web";

const columnStyle: CSSProperties = {
  position: "relative",
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-end",
  width: "100%",
  minWidth: 0,
  flexShrink: 0,
  pointerEvents: "none",
};
const trailingStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-end",
  width: "100%",
  pointerEvents: "none",
};

interface WebMessageGeometry {
  width: number;
  naturalHeight: number | undefined;
  naturalWidth: number | undefined;
  padding: number;
  textWidth: number;
  prefixHeight: number;
  textTop: number;
  summaryWidth: number;
  summaryHeight: number;
  controlsWidth: number;
  controlsHeight: number;
  trailingHeight: number;
}

/** Only a complete live sample supplies projection dimensions. Invalidated
 * preparation falls back to ordinary layout until its real nodes measure again.
 */
function webMessageGeometry(
  sample: ReturnType<typeof useWebMessageMeasurements>["measurement"],
  hasText: boolean,
): WebMessageGeometry {
  if (!sample)
    return {
      width: 0,
      naturalHeight: undefined,
      naturalWidth: undefined,
      padding: 0,
      textWidth: 0,
      prefixHeight: 0,
      textTop: 0,
      summaryWidth: 0,
      summaryHeight: 0,
      controlsWidth: 0,
      controlsHeight: 0,
      trailingHeight: 0,
    };
  const { metrics } = sample;
  return {
    width: metrics.width,
    naturalHeight: metrics.bodyHeight ?? undefined,
    naturalWidth: metrics.bubble?.width,
    padding: metrics.content?.x ?? 0,
    textWidth: hasText ? (metrics.text?.width ?? 0) : 0,
    prefixHeight: hasText ? (metrics.prefixHeight ?? 0) : 0,
    textTop: (metrics.content?.y ?? 0) + (metrics.text?.y ?? 0),
    summaryWidth: sample.summaryWidth,
    summaryHeight: sample.summaryHeight,
    controlsWidth: metrics.controls?.width ?? 0,
    controlsHeight: metrics.controls?.height ?? 0,
    trailingHeight: sample.visualTrailingHeight,
  };
}

/** Compact controls cover the right end without moving the natural bubble or Text. */
function webMessageWidths(g: WebMessageGeometry, compact: boolean, bounded: boolean) {
  const clipWidth = bounded ? g.naturalWidth : undefined;
  const inset = bounded && clipWidth !== undefined ? g.width - clipWidth : 0;
  return {
    clipWidth,
    inset,
    controlGap: g.controlsWidth > 0 ? SPACING[2] : 0,
    clipTextWidth: compact ? g.textWidth : undefined,
    textTranslateX: 0,
  };
}

/** Disclosure overlays the bubble; the body and trailing actions share the
 * existing total cap without adding a separate footer to the natural body.
 */
function webMessageHeights(
  g: WebMessageGeometry,
  bubbleChrome: number,
  maximumHeight: number | undefined,
  compact: boolean,
  bounded: boolean,
) {
  const compactHeight = Math.max(
    Math.max(g.prefixHeight, g.summaryHeight) + bubbleChrome,
    g.controlsHeight,
  );
  const cap = Math.max(0, (maximumHeight ?? Infinity) - g.trailingHeight);
  return {
    cap,
    bodyHeight: bounded
      ? Math.min(compact ? compactHeight : (g.naturalHeight ?? 0), cap)
      : undefined,
    textTranslateY: compact ? (compactHeight - g.prefixHeight) / 2 - g.textTop : 0,
  };
}

/** Paint the exact opaque control rectangle; the original bubble keeps its own corners. */
function MessageControlBacking({
  visible,
  style,
  region,
  height,
}: {
  visible: boolean;
  style: StyleProp<ViewStyle>;
  region: "summary" | "controls";
  height: number;
}) {
  const dataSet = useMemo(() => ({ userMessageCompactOcclusion: region }), [region]);
  const backing = useMemo<StyleProp<ViewStyle>>(
    () => [
      style,
      StyleSheet.absoluteFill,
      {
        width: "100%",
        height: "100%",
        padding: 0,
        minWidth: 0,
        minHeight: 0,
        borderTopLeftRadius: 0,
        borderTopRightRadius: 0,
        borderBottomRightRadius: 0,
        borderBottomLeftRadius: 0,
      },
    ],
    [style],
  );
  if (!visible || height === 0) return null;
  return (
    <View style={backing} pointerEvents="none" accessible={false} aria-hidden dataSet={dataSet} />
  );
}

/** The existing web body remains one ordinary-width layout. Its outer row owns
 * the natural reservation; this child owns only the bounded CSS-sticky paint.
 * More and Less overlay the bubble without changing natural Text layout.
 */
export function WebUserMessageFlow(props: UserMessageFlowProps) {
  const { onGeometry, onHoverChange } = props;
  const measured = useWebMessageMeasurements(props);
  const sample = measured.measurement;
  const metrics = sample?.metrics;
  const hasText = props.message.trim().length > 0;
  const flow = metrics ? resolveMessageFlow({ measurements: metrics, hasText }) : null;
  const compact = props.compact && flow !== null;
  const bounded = props.bounded && flow !== null;
  const expanded = bounded && !compact;
  const viewport = useRef<NativeScrollView>(null);
  const attachments = useRef<HTMLElement | null>(null);
  const wasBounded = useRef(props.bounded);
  const g = webMessageGeometry(sample, hasText);
  const { width, naturalHeight, padding, textWidth, summaryHeight, controlsWidth, controlsHeight } =
    g;
  const { clipWidth, inset, controlGap, clipTextWidth, textTranslateX } = webMessageWidths(
    g,
    compact,
    bounded,
  );
  const { cap, bodyHeight, textTranslateY } = webMessageHeights(
    g,
    flow?.bubbleChrome ?? 0,
    props.maximumHeight,
    compact,
    bounded,
  );

  const registerAttachments = useCallback(
    (node: ComponentRef<typeof View> | null) => {
      if (attachments.current) attachments.current.inert = false;
      attachments.current = node instanceof HTMLElement ? node : null;
      // Opacity preserves layout but would leave keyboard-focusable image actions.
      // Inert belongs only to this retained attachment subtree, never the Text.
      if (attachments.current) attachments.current.inert = compact;
    },
    [compact],
  );
  const context = useMemo<MessageFlowContext>(
    () => ({
      web: true,
      webRailWidth: measured.width,
      webContentPadding: bounded,
      compact,
      bubbleWidth: clipWidth,
      bubbleHeight: bodyHeight,
      contentWidth: bounded ? metrics?.content?.width : undefined,
      textWidth: bounded ? textWidth : undefined,
      textHeight: bounded ? sample?.textHeight : undefined,
      clipText: compact,
      textClipWidth: clipTextWidth,
      textPrefixHeight: undefined,
      textTranslateX,
      textTranslateY,
      register: measured.register,
      reportFrame: measured.reportFrame,
      reportText: measured.reportText,
      registerAttachments,
    }),
    [
      compact,
      clipWidth,
      bodyHeight,
      bounded,
      metrics?.content?.width,
      textWidth,
      sample?.textHeight,
      clipTextWidth,
      textTranslateX,
      textTranslateY,
      measured.width,
      measured.register,
      measured.reportFrame,
      measured.reportText,
      registerAttachments,
    ],
  );

  useLayoutEffect(() => {
    const becameOrdinary = wasBounded.current && !props.bounded;
    wasBounded.current = props.bounded;
    if (compact || becameOrdinary) viewport.current?.scrollTo({ y: 0, animated: false });
  }, [compact, props.bounded]);

  const flowHeight = flow?.flowHeight;
  const publishGeometry = useCallback(() => {
    const rail = measured.rail.current;
    if (flowHeight === undefined || !rail) {
      onGeometry(null);
      return;
    }
    onGeometry({ flowHeight, visualHeight: rail.getBoundingClientRect().height });
  }, [flowHeight, measured.rail, onGeometry]);
  useLayoutEffect(publishGeometry, [publishGeometry, bounded, compact, bodyHeight, controlsHeight]);
  useLayoutEffect(() => {
    const rail = measured.rail.current;
    if (!rail) return;
    const observer = new ResizeObserver(publishGeometry);
    observer.observe(rail);
    return () => observer.disconnect();
  }, [measured.rail, publishGeometry]);
  // Invalidation publishes ordinary geometry in layout, after DOM changes. Do
  // not clear a valid reservation from the previous layout effect's cleanup.
  useEffect(() => () => onGeometry(null), [onGeometry]);

  const clipStyle = useMemo<CSSProperties>(
    () => ({
      position: "relative",
      width: clipWidth ?? "100%",
      height: bodyHeight,
      minWidth: 0,
      flexShrink: 0,
      overflow: bounded ? "hidden" : "visible",
      borderRadius: bounded ? sample?.corners : undefined,
      pointerEvents: "none",
    }),
    [clipWidth, bodyHeight, bounded, sample?.corners],
  );
  const bodyStyle = useMemo<CSSProperties>(
    () => ({
      ...columnStyle,
      width: width > 0 ? width : "100%",
      height: naturalHeight,
      marginLeft: -inset,
    }),
    [width, naturalHeight, inset],
  );
  const scrollStyle = useMemo<StyleProp<ViewStyle>>(
    () => ({
      width: "100%",
      flexGrow: 0,
      flexShrink: 0,
      height: bodyHeight,
      maxHeight: bounded ? cap : undefined,
    }),
    [bodyHeight, bounded, cap],
  );
  const summaryStyle = useMemo<CSSProperties>(
    () => ({
      position: "absolute",
      right: padding + controlsWidth + controlGap,
      top: ((bodyHeight ?? 0) - summaryHeight) / 2,
      width: "max-content",
      overflow: "hidden",
      // The end overlay may extend left of a very small bubble within the rail.
      // Its count can ellipsize; More keeps its independent hit area.
      maxWidth: Math.max(0, width - padding * 2 - controlsWidth - controlGap),
      visibility: compact ? "visible" : "hidden",
      pointerEvents: compact ? "auto" : "none",
    }),
    [padding, bodyHeight, summaryHeight, width, controlsWidth, controlGap, compact],
  );
  const controlsStyle = useMemo<CSSProperties>(
    () => ({
      position: "absolute",
      top: compact ? ((bodyHeight ?? 0) - controlsHeight) / 2 : 0,
      right: padding,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      width: "max-content",
      maxWidth: Math.max(0, width - padding * 2),
      minHeight: props.controls ? CONTROL_HEIGHTS.field : 0,
      flexShrink: 0,
      visibility: bounded ? "visible" : "hidden",
      pointerEvents: bounded ? "auto" : "none",
    }),
    [compact, bodyHeight, controlsHeight, padding, width, bounded, props.controls],
  );
  // Ordinary flow owns this entire allocation, including the gap to its actions.
  // Bounded paint must still let later chat receive input outside its real content.
  const hoverStyle = useMemo<CSSProperties>(
    () => ({ ...columnStyle, pointerEvents: bounded ? "none" : "auto" }),
    [bounded],
  );
  const handlePointerEnter = useCallback(() => onHoverChange?.(true), [onHoverChange]);
  const handlePointerLeave = useCallback(() => onHoverChange?.(false), [onHoverChange]);
  const backdropStyle = useMemo(
    () => [StyleSheet.absoluteFill, props.backdropStyle],
    [props.backdropStyle],
  );
  const dataSet = useMemo(() => ({ bodyExpanded: String(!compact) }), [compact]);
  return (
    <NaturalMessageFlowContext.Provider value={context}>
      <div
        ref={measured.rail}
        style={hoverStyle}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
      >
        <div style={clipStyle}>
          {bounded ? (
            <View style={backdropStyle} pointerEvents="none" accessible={false} aria-hidden />
          ) : null}
          <ScrollView
            ref={viewport}
            style={scrollStyle}
            pointerEvents="box-none"
            scrollEnabled={expanded}
            nestedScrollEnabled={expanded}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={expanded}
            testID="user-message-body-scroll"
            dataSet={dataSet}
          >
            <div ref={measured.body} style={bodyStyle}>
              {props.children}
            </div>
          </ScrollView>
        </div>
        <div ref={measured.summary} style={summaryStyle} aria-hidden={!compact}>
          <MessageControlBacking
            visible={compact}
            style={props.backdropStyle}
            region="summary"
            height={summaryHeight}
          />
          {props.summary}
        </div>
        <div ref={measured.registerControls} style={controlsStyle} aria-hidden={!bounded}>
          <MessageControlBacking
            visible={bounded}
            style={props.backdropStyle}
            region="controls"
            height={controlsHeight}
          />
          {props.controls}
        </div>
        <div ref={measured.trailing} style={trailingStyle}>
          {props.trailing}
        </div>
      </div>
    </NaturalMessageFlowContext.Provider>
  );
}
