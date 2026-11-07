import { useCallback, useContext, useMemo } from "react";
import { View, type TextLayoutEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { TextPreview } from "@/components/ui/text-preview";
import { isWeb } from "@/constants/platform";
import { useTextLink } from "@/hooks/use-text-link";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { MESSAGE_TEXT_DATASET } from "./message-layout";
import type { UserMessageProps } from "./user-message";
import { NaturalMessageFlowContext } from "./user-message-flow";
import { NativeMessageSuffixMask } from "./user-message-native-flow";

function ignorePreviewOverflow(_overflowing: boolean): void {
  return;
}

/** Keep the actual message text mounted while disclosure changes its visible height. */
export function UserMessageText({
  message,
  hasText,
  previewLines,
  previewExpanded,
  onPreviewOverflowChange,
  hideTextAccessibility,
  onContentPress,
  contentAccessibilityLabel,
}: Pick<
  UserMessageProps,
  | "message"
  | "previewLines"
  | "previewExpanded"
  | "onPreviewOverflowChange"
  | "hideTextAccessibility"
  | "onContentPress"
  | "contentAccessibilityLabel"
> & { hasText: boolean }) {
  const naturalFlow = useContext(NaturalMessageFlowContext);
  const reportTextLayout = useCallback(
    (event: TextLayoutEvent) => {
      naturalFlow?.reportText(event.nativeEvent.lines);
      if (naturalFlow) {
        onPreviewOverflowChange?.(event.nativeEvent.lines.length > (previewLines ?? 1));
      }
    },
    [naturalFlow, onPreviewOverflowChange, previewLines],
  );
  const compactPrefixHeight = naturalFlow?.textPrefixHeight;
  const suffixMaskStyle = useMemo(
    () => [
      userMessageTextStyles.textMask,
      inlineUnistylesStyle({ top: compactPrefixHeight ?? 0, bottom: 0 }),
    ],
    [compactPrefixHeight],
  );
  const keyboardLink = useTextLink(onContentPress);
  const textAccessibility = useMemo(
    () =>
      onContentPress && !naturalFlow?.nativePresentation
        ? {
            accessible: true,
            "aria-hidden": false,
            accessibilityRole: "link" as const,
            accessibilityLabel: hideTextAccessibility ? contentAccessibilityLabel : undefined,
            accessibilityHint: contentAccessibilityLabel,
            onPress: onContentPress,
            ...keyboardLink,
          }
        : { accessible: !hideTextAccessibility, "aria-hidden": hideTextAccessibility },
    [
      onContentPress,
      hideTextAccessibility,
      contentAccessibilityLabel,
      keyboardLink,
      naturalFlow?.nativePresentation,
    ],
  );
  return (
    <View style={userMessageTextStyles.textRegion}>
      {hasText && (
        <TextPreview
          onTextLayout={reportTextLayout}
          selectable
          numberOfLines={previewLines ?? 1}
          expanded={
            !naturalFlow?.clipText &&
            (naturalFlow !== null || previewExpanded || previewLines === undefined)
          }
          onOverflowChange={onPreviewOverflowChange ?? ignorePreviewOverflow}
          style={userMessageTextStyles.text}
          {...textAccessibility}
          testID="user-message-text"
          dataSet={MESSAGE_TEXT_DATASET}
        >
          {message}
        </TextPreview>
      )}
      {/* Keep the one natural Text fully laid out; mask only suffix ink beyond
          the current measured first line, without changing its flow height. */}
      {naturalFlow?.nativePresentation ? (
        <NativeMessageSuffixMask
          driver={naturalFlow.nativePresentation}
          backgroundStyle={userMessageTextStyles.textMask}
        />
      ) : (
        compactPrefixHeight !== undefined && (
          <View
            style={suffixMaskStyle}
            pointerEvents="none"
            accessible={false}
            testID="user-message-suffix-mask"
            aria-hidden
          />
        )
      )}
    </View>
  );
}

const userMessageTextStyles = StyleSheet.create((theme) => ({
  textRegion: { minWidth: 0, flexShrink: 1 },
  textMask: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: theme.colors.userMessageBackground,
  },
  text: {
    color: theme.colors.userMessageForeground,
    fontSize: theme.fontSize.content,
    ...(isWeb
      ? {
          lineHeight: Math.round(theme.fontSize.content * 1.4),
          overflowWrap: "anywhere" as const,
        }
      : {}),
  },
}));
