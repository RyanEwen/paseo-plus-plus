import { useTextLink } from "@/hooks/use-text-link";
import { useCallback, useContext, useMemo } from "react";
import { Text, View, type GestureResponderEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { AgentAttachment } from "@getpaseo/protocol/messages";
import type { UserMessageImageAttachment } from "@/types/stream";
import { getAgentAttachmentPillContent } from "@/attachments/attachment-pill-content";
import { AttachmentFrame, AttachmentLabel, AttachmentThumbnail } from "./attachment-pill";
import { NaturalMessageFlowContext } from "./user-message-flow";
import { NativeMessageVisibility } from "./user-message-native-flow";

/** A compact copy counts attachments; disclosure restores every original attachment pill. */
export function UserMessageAttachments({
  onContentPress,
  contentAccessibilityLabel,
  images,
  attachments,
  compact,
  hasText,
  onOpen,
}: {
  onContentPress?: (event: GestureResponderEvent) => void;
  contentAccessibilityLabel?: string;
  images: UserMessageImageAttachment[];
  attachments: AgentAttachment[];
  compact: boolean;
  hasText: boolean;
  onOpen: (image: UserMessageImageAttachment) => void;
}) {
  const { t } = useTranslation();
  const flow = useContext(NaturalMessageFlowContext);
  if (compact && !flow) {
    return (
      <UserMessageAttachmentSummary
        count={images.length + attachments.length}
        hasText={hasText}
        onContentPress={onContentPress}
        contentAccessibilityLabel={contentAccessibilityLabel}
      />
    );
  }
  const attachmentPills = (
    <>
      {images.length > 0 && (
        <View style={[styles.row, (hasText || attachments.length > 0) && styles.spacing]}>
          {images.map((image) => (
            <ImagePill
              key={image.id}
              image={image}
              onOpen={onOpen}
              label={t("composer.attachments.openImage")}
            />
          ))}
        </View>
      )}
      {attachments.length > 0 && (
        <View style={[styles.row, hasText && styles.spacing]}>
          {attachments.map((attachment, index) => {
            const content = getAgentAttachmentPillContent(attachment, t);
            return (
              <AttachmentFrame
                key={`${attachment.type}:${"number" in attachment ? attachment.number : index}`}
              >
                <AttachmentLabel
                  icon={content.icon}
                  title={content.title}
                  subtitle={content.subtitle}
                />
              </AttachmentFrame>
            );
          })}
        </View>
      )}
    </>
  );
  if (!flow) return attachmentPills;
  if (flow.nativePresentation) {
    return (
      <NativeMessageVisibility driver={flow.nativePresentation} visible="body">
        {attachmentPills}
      </NativeMessageVisibility>
    );
  }
  return (
    <View
      style={flow.compact ? styles.hidden : undefined}
      pointerEvents={flow.compact ? "none" : "box-none"}
      accessibilityElementsHidden={flow.compact}
      importantForAccessibility={flow.compact ? "no-hide-descendants" : "auto"}
      aria-hidden={flow.compact}
    >
      {attachmentPills}
    </View>
  );
}

/** The compact count is presentation chrome; the real attachment controls stay mounted. */
export function UserMessageAttachmentSummary({
  count,
  hasText,
  onContentPress,
  contentAccessibilityLabel,
}: {
  count: number;
  hasText: boolean;
  onContentPress?: (event: GestureResponderEvent) => void;
  contentAccessibilityLabel?: string;
}) {
  const { t } = useTranslation();
  const keyboardLink = useTextLink(onContentPress);
  const summaryStyle = useMemo(
    () => [styles.summary, hasText ? styles.sharedSummary : undefined],
    [hasText],
  );
  if (count === 0) return null;
  return (
    <Text
      testID="user-message-attachments-summary"
      style={summaryStyle}
      numberOfLines={1}
      {...keyboardLink}
      onPress={onContentPress}
      accessibilityRole={onContentPress ? "link" : undefined}
      accessibilityHint={contentAccessibilityLabel}
    >
      {t("stickyPrompt.attachments", { count })}
    </Text>
  );
}

function ImagePill({
  image,
  onOpen,
  label,
}: {
  image: UserMessageImageAttachment;
  onOpen: (image: UserMessageImageAttachment) => void;
  label: string;
}) {
  const open = useCallback(() => onOpen(image), [image, onOpen]);
  return (
    <AttachmentFrame onPress={open} accessibilityLabel={label}>
      <AttachmentThumbnail metadata={image} />
    </AttachmentFrame>
  );
}

const styles = StyleSheet.create((theme) => ({
  hidden: { opacity: 0 },
  row: { flexDirection: "row", gap: theme.spacing[2], flexWrap: "wrap" },
  spacing: { marginBottom: theme.spacing[2] },
  sharedSummary: { flex: 1, minWidth: 0 },
  summary: {
    color: theme.colors.userMessageMutedForeground,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
  },
}));
