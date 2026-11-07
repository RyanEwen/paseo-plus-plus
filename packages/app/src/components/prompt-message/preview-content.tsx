import { measuredHeightStyle, measuredWidthStyle, previewTextClipStyle } from "./measured-styles";
import {
  useCallback,
  useContext,
  useMemo,
  type ComponentRef,
  type ContextType,
  type ReactNode,
} from "react";
import { ScrollView } from "@/components/ui/scroll-view";
import { View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { controlHeightForLayout } from "@/components/ui/control-geometry";
import { NaturalMessageFlowContext, type UserMessageBodyPresentation } from "./flow";
import { MessagePreview } from "../user-message/index";
import { NativeMessageTextPaint } from "./native-flow";

/** Keep one body ancestry in both disclosure states. The capped parent column
 * reserves its real padding/action height; the body alone may shrink and scroll.
 */
export function UserMessagePreviewContent({
  children,
  action,
  attachments,
  compact = false,
  hasText,
  bounded = false,
  bodyPresentation = "actualPrompt",
  forceExpanded = false,
}: {
  children: ReactNode;
  action?: ReactNode;
  attachments?: ReactNode;
  compact?: boolean;
  hasText: boolean;
  bounded?: boolean;
  bodyPresentation?: UserMessageBodyPresentation;
  forceExpanded?: boolean;
}) {
  const naturalFlow = useContext(NaturalMessageFlowContext);
  const contentStyle = useMemo(() => {
    if (compact) return [styles.text, styles.previewText];
    return [styles.text, bounded ? styles.expandedText : undefined];
  }, [bounded, compact]);
  const rowStyle = useMemo(() => [styles.row, bounded ? styles.bounded : undefined], [bounded]);
  const dataSet = useMemo(() => ({ bodyExpanded: String(!compact) }), [compact]);
  if (naturalFlow) {
    return (
      <NaturalMessageContent
        flow={naturalFlow}
        attachments={attachments}
        hasText={hasText}
        bodyPresentation={bodyPresentation}
        forceExpanded={forceExpanded}
      >
        {children}
      </NaturalMessageContent>
    );
  }
  const body = (
    <View style={contentStyle}>
      <MessagePreview
        enabled={bodyPresentation === "ordinaryPreview"}
        forceExpanded={forceExpanded}
      >
        {attachments}
        <View style={compact ? styles.content : styles.fullContent}>{hasText && children}</View>
      </MessagePreview>
    </View>
  );
  return (
    <View style={rowStyle}>
      {
        <ScrollView
          style={styles.bodyViewport}
          scrollEnabled={bounded && !compact}
          nestedScrollEnabled={bounded && !compact}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={bounded && !compact}
          testID="user-message-body-scroll"
          dataSet={dataSet}
        >
          {body}
        </ScrollView>
      }

      {action ? (
        <View style={styles.action} pointerEvents="box-none">
          {action}
        </View>
      ) : null}
    </View>
  );
}

interface NaturalMessageContentProps {
  flow: NonNullable<ContextType<typeof NaturalMessageFlowContext>>;
  attachments: ReactNode;
  hasText: boolean;
  children: ReactNode;
  bodyPresentation: UserMessageBodyPresentation;
  forceExpanded: boolean;
}

/** The one full body retains ordinary wrapping even when its painted prefix moves. */
function NaturalMessageContent({
  flow,
  attachments,
  hasText,
  children,
  bodyPresentation,
  forceExpanded,
}: NaturalMessageContentProps) {
  const registerContent = useCallback(
    (node: ComponentRef<typeof View> | null) => {
      flow.register("content", node);
    },
    [flow],
  );
  const registerText = useCallback(
    (node: ComponentRef<typeof View> | null) => {
      flow.register("text", node);
    },
    [flow],
  );
  const measureContent = useCallback(
    (event: LayoutChangeEvent) => {
      flow.reportFrame("content", event);
    },
    [flow],
  );
  const measureText = useCallback(
    (event: LayoutChangeEvent) => {
      flow.reportFrame("text", event);
    },
    [flow],
  );
  const textWidthStyle = useMemo(() => measuredWidthStyle(flow.textWidth), [flow.textWidth]);
  const clipStyle = useMemo<StyleProp<ViewStyle>>(
    () => [
      styles.fullContent,
      previewTextClipStyle({
        width: flow.textClipWidth,
        compact: flow.compact,
        web: flow.web === true,
        translateX: flow.textTranslateX,
        translateY: flow.textTranslateY,
      }),
    ],
    [flow.textClipWidth, flow.compact, flow.textTranslateX, flow.textTranslateY, flow.web],
  );
  const textFrameStyle = useMemo<StyleProp<ViewStyle>>(
    () => [styles.fullContent, textWidthStyle, measuredHeightStyle(flow.textHeight)],
    [textWidthStyle, flow.textHeight],
  );
  const naturalText = <View style={textWidthStyle}>{hasText && children}</View>;
  const webContentStyle = useMemo(
    () => [
      styles.fullContent,
      flow.webContentPadding ? styles.expandedText : undefined,
      measuredWidthStyle(flow.contentWidth),
    ],
    [flow.contentWidth, flow.webContentPadding],
  );
  const naturalBody = (
    <View
      style={styles.fullContent}
      ref={registerContent}
      onLayout={measureContent}
      collapsable={false}
    >
      <MessagePreview
        enabled={bodyPresentation === "ordinaryPreview"}
        forceExpanded={forceExpanded}
      >
        {attachments}
        <View style={textFrameStyle} ref={registerText} onLayout={measureText} collapsable={false}>
          {flow.nativePresentation ? (
            <NativeMessageTextPaint driver={flow.nativePresentation}>
              {naturalText}
            </NativeMessageTextPaint>
          ) : (
            <View style={clipStyle}>{naturalText}</View>
          )}
        </View>
      </MessagePreview>
    </View>
  );
  // Keep web's existing inner padding cell. Only its full natural contents, not
  // the compact bubble's outer rectangle, determine the transcript reservation.
  return flow.web ? <View style={webContentStyle}>{naturalBody}</View> : naturalBody;
}

const styles = StyleSheet.create((theme) => ({
  row: { flexDirection: "row", alignItems: "stretch", gap: theme.spacing[2], minHeight: 0 },
  bounded: { flexShrink: 1 },
  text: { flexGrow: 1, flexShrink: 1, flexBasis: "auto", minWidth: 0 },
  content: { flex: 1, minWidth: 0 },
  fullContent: { minWidth: 0 },
  bodyViewport: { flexGrow: 1, flexShrink: 1, flexBasis: "auto", minWidth: 0, minHeight: 0 },
  expandedText: { paddingVertical: theme.spacing[4] },
  previewText: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[4],
    minHeight: Math.round(theme.fontSize.content * 1.4) + theme.spacing[4] * 2,
  },
  action: {
    // The 44 px field height the preview row has always reserved, at every width.
    minHeight: controlHeightForLayout("md", true),
    justifyContent: "center",
    alignSelf: "center",
    flexShrink: 0,
  },
}));
