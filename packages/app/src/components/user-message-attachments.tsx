import { useCallback, useContext, type ComponentRef } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { AgentAttachment } from "@getpaseo/protocol/messages";
import type { UserMessageImageAttachment } from "@/types/stream";
import { getAgentAttachmentPillContent } from "@/attachments/attachment-pill-content";
import { AttachmentFrame, AttachmentLabel, AttachmentThumbnail } from "./attachment-pill";
import { NaturalMessageFlowContext } from "./user-message-flow";
import { NativeMessageVisibility } from "./user-message-native-flow";

/** Compact paint omits attachments; disclosure reveals the original attachment pills. */
export function UserMessageAttachments({
  images,
  attachments,
  compact,
  hasText,
  onOpen,
}: {
  images: UserMessageImageAttachment[];
  attachments: AgentAttachment[];
  compact: boolean;
  hasText: boolean;
  onOpen: (image: UserMessageImageAttachment) => void;
}) {
  const { t } = useTranslation();
  const flow = useContext(NaturalMessageFlowContext);
  const registerAttachments = useCallback(
    (node: ComponentRef<typeof View> | null) => flow?.registerAttachments?.(node),
    [flow],
  );
  if (compact && !flow) return null;
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
      ref={registerAttachments}
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
}));
