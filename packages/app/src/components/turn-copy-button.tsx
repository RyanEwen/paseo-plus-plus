import { ICON_SIZE } from "@/styles/theme";
import { Check, Copy } from "lucide-react-native";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { StyleProp, ViewStyle } from "react-native";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StyleSheet } from "react-native-unistyles";
const turnCopyButtonStylesheet = StyleSheet.create((theme) => ({
  container: {
    alignSelf: "flex-start",
    padding: theme.spacing[2],
    paddingTop: 0,
    marginTop: theme.spacing[2],
  },
  pressed: { backgroundColor: theme.colors.interactionHighlight },
  iconColor: {
    color: theme.colors.foregroundMuted,
  },
  iconHoveredColor: {
    color: theme.colors.foreground,
  },
}));

interface TurnCopyButtonProps {
  getContent: () => string;
  containerStyle?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  copiedAccessibilityLabel?: string;
}

export const TurnCopyButton = memo(function TurnCopyButton({
  getContent,
  containerStyle,
  accessibilityLabel,
  copiedAccessibilityLabel,
}: TurnCopyButtonProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopy = useCallback(async () => {
    const content = getContent();
    if (!content) {
      return;
    }

    // Clipboard codecs and platform services are only needed for an explicit copy action.
    const [{ writeMarkdownToRichClipboard }, { getDefaultMarkdownClipboardEnvironment }] =
      await Promise.all([
        import("@/utils/rich-clipboard"),
        import("@/utils/rich-clipboard-default-environment"),
      ]);
    await writeMarkdownToRichClipboard(content, getDefaultMarkdownClipboardEnvironment());
    setCopied(true);

    if (copyTimeoutRef.current) {
      clearTimeout(copyTimeoutRef.current);
    }

    copyTimeoutRef.current = setTimeout(() => {
      setCopied(false);
      copyTimeoutRef.current = null;
    }, 1500);
  }, [getContent]);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const pressableStyle = useMemo(
    () => [turnCopyButtonStylesheet.container, containerStyle],
    [containerStyle],
  );

  return (
    <PressHighlight
      onPress={handleCopy}
      style={pressableStyle}
      highlightStyle={turnCopyButtonStylesheet.pressed}
      accessibilityRole="button"
      accessibilityLabel={
        copied
          ? (copiedAccessibilityLabel ?? t("message.actions.copied"))
          : (accessibilityLabel ?? t("message.actions.copyTurn"))
      }
    >
      {({ hovered }) => {
        const iconColor = hovered
          ? turnCopyButtonStylesheet.iconHoveredColor.color
          : turnCopyButtonStylesheet.iconColor.color;
        return copied ? (
          <Check size={ICON_SIZE.sm} color={iconColor} />
        ) : (
          <Copy size={ICON_SIZE.sm} color={iconColor} />
        );
      }}
    </PressHighlight>
  );
});
