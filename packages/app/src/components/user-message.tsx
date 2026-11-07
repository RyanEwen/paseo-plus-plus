import type { AgentMessage } from "@getpaseo/protocol/agent-message";
import { MessageSender } from "./user-message/index";
import type { TextLinkEvent } from "@/hooks/use-text-link";
import { UserMessagePreviewContent } from "./user-message-preview-content";
import { UserMessageAttachments } from "./user-message-attachments";
import {
  NaturalMessageBubble,
  type NaturalMessageGeometry,
  type UserMessageBodyPresentation,
} from "./user-message-flow";
import { WebUserMessageFlow } from "./user-message-web-flow";
import { AttachmentLightbox, type ImageLightboxSource } from "@/components/attachment-lightbox";
import type { RewindMode } from "@/components/rewind/rewind-menu";
import { useRewindAgentMutation } from "@/components/rewind/use-rewind-agent-mutation";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative, isWeb } from "@/constants/platform";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { SPACING } from "@/styles/theme";
import type { UserMessageImageAttachment } from "@/types/stream";
import { formatMessageTimestamp } from "@/utils/time";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentCapabilityFlags } from "@getpaseo/protocol/agent-types";
import type { AgentAttachment } from "@getpaseo/protocol/messages";
import type { ReactNode } from "react";
import { memo, useCallback, useContext, useMemo, useState } from "react";
import { View, type PressableStateCallbackType } from "react-native";
import { PressHighlight } from "@/components/ui/press-highlight";
import { resolveHighlightCorners } from "@/components/ui/press-highlight.shape";
import { NativeMessagePresentationContext } from "./user-message-native-presentation";
import { NativeUserMessageFlow, NativeMessageVisibility } from "./user-message-native-flow";
import { StyleSheet } from "react-native-unistyles";
import { useDisableOuterSpacing } from "./message-layout";
import { UserMessageText } from "./user-message-text";
import { UserMessageTextActions, UserMessageTrailingRow } from "./user-message-trailing-row";
export interface UserMessageProps {
  /** Shared fallback callers retain natural layout unless the chat owner opts into previews. */
  bodyPresentation?: UserMessageBodyPresentation;
  forceOrdinaryPreviewExpanded?: boolean;
  sender?: AgentMessage["sender"];
  /** An optional measured viewport retains the one ordinary body's natural flow. */
  onNaturalFlowGeometry?: (geometry: NaturalMessageGeometry | null) => void;
  onContentPress?: (event: TextLinkEvent) => void;
  contentAccessibilityLabel?: string;
  /** Measured source width keeps the sticky copy's glyph positions aligned at the edge. */
  bubbleWidth?: number;
  hideTextAccessibility?: boolean;
  /** Optional accessible content action, rendered inside the bubble. */
  contentAction?: ReactNode;
  /** Reserve space beside the compact preview for its disclosure. */
  inlineContentAction?: ReactNode;
  /** A pinned bubble meets the panel edge without a rounded top-left corner. */
  pinned?: boolean;
  /** Protect floating metadata and navigation without covering the surrounding conversation. */
  actionRowBackdrop?: ReactNode;
  navigationActions?: ReactNode;
  /** Explicit arrow navigation holds actions independently of actual pointer hover. */
  keepActionsVisible?: boolean;
  previewLines?: number;
  /** Keep the actual Text/attachment body mounted through disclosure. */
  previewExpanded?: boolean;
  bodyViewportHeight?: number;
  /** Prepare web compact paint against the same cap before it becomes bounded. */
  naturalFlowMaximumHeight?: number;
  onPreviewOverflowChange?: (overflowing: boolean) => void;
  serverId?: string;
  agentId?: string;
  messageId?: string;
  message: string;
  images?: UserMessageImageAttachment[];
  attachments?: AgentAttachment[];
  timestamp: number;
  capabilities?: AgentCapabilityFlags;
  client?: DaemonClient | null;
  isFirstInGroup?: boolean;
  isLastInGroup?: boolean;
  isPending?: boolean;
  disableOuterSpacing?: boolean;
}

const EMPTY_MESSAGE_IMAGES: UserMessageImageAttachment[] = [];
const EMPTY_MESSAGE_ATTACHMENTS: AgentAttachment[] = [];

const userMessageStylesheet = StyleSheet.create((theme) => ({
  contentPressTarget: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    cursor: "pointer",
  },
  contentPressFeedback: { backgroundColor: theme.colors.interactionHighlight },
  container: {
    flexDirection: "row",
    justifyContent: "flex-end",
    ...(isWeb ? { userSelect: "text" as const } : {}),
  },
  content: {
    alignItems: "flex-end",
    // Let the message column shrink to its chat rail before measuring the body.
    minWidth: 0,
    flexShrink: 1,
    maxWidth: "100%",
    cursor: "auto",
  },
  containerSpacing: {
    marginBottom: theme.spacing[1],
  },
  containerFirstInGroup: {
    marginTop: theme.spacing[4],
  },
  containerLastInGroup: {
    marginBottom: theme.spacing[4],
  },
  bubble: {
    backgroundColor: theme.colors.userMessageBackground,
    borderRadius: theme.borderRadius["2xl"],
    borderTopRightRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[4],
    minWidth: 0,
    // End alignment does not stretch or constrain this child's intrinsic width.
    maxWidth: "100%",
    minHeight: 0,
    flexShrink: 1,
  },
  pinnedBubble: { borderTopLeftRadius: 0 },
  previewBubble: { paddingVertical: 0 },
  trailingRow: {
    alignSelf: "flex-end",
    marginTop: theme.spacing[2],
  },
  // The absolute-fill backdrop follows this padding, keeping content inside its edges.
  trailingRowWithBackdrop: { padding: theme.spacing[2], flexShrink: 0 },
  // Pinned previews already place their controls directly below the compact bubble.
  trailingRowPreview: { marginTop: 0 },
  trailingRowHidden: {
    opacity: 0,
  },
  trailingRowVisible: {
    opacity: 1,
  },
}));

/** Preserve the original bubble geometry, with a square top edge only for its pinned copy. */
function resolveUserMessageBubbleStyle(
  width: number | undefined,
  pinned: boolean | undefined,
  compactPreview: boolean,
) {
  return [
    userMessageStylesheet.bubble,
    pinned ? userMessageStylesheet.pinnedBubble : undefined,
    compactPreview ? userMessageStylesheet.previewBubble : undefined,
    width === undefined ? undefined : inlineUnistylesStyle({ width }),
  ];
}

/** Touch actions remain available; desktop navigation visibility does not alter actual hover. */
function areMessageActionsVisible(compact: boolean, hovered: boolean, navigationHeld?: boolean) {
  return compact || isNative || hovered || navigationHeld === true;
}

/** Keep ordinary action visibility independent of the native sticky paint mode. */
interface UserMessageActionVisibility {
  pending: boolean;
  hasActions: boolean;
  compact: boolean;
  hovered: boolean;
  navigationHeld: boolean | undefined;
}

function shouldShowUserMessageActions({
  pending,
  hasActions,
  compact,
  hovered,
  navigationHeld,
}: UserMessageActionVisibility) {
  return !pending && hasActions && areMessageActionsVisible(compact, hovered, navigationHeld);
}

function userMessageHitAllocation(actualWebPrompt: boolean) {
  if (actualWebPrompt) return "box-none";
  return "auto";
}

/** The action row's existing compact backing padding is independent of More. */
function compactMessageActionPadding(webNaturalFlow: boolean, hasTrailingRow: boolean): number {
  return webNaturalFlow && hasTrailingRow ? SPACING[2] * 2 : 0;
}

/** Select the platform flow and its presentation flags without changing body ownership. */
function userMessageFlowConfiguration(
  hasNaturalFlow: boolean,
  hasBodyViewport: boolean,
  hasNativeDriver: boolean,
) {
  return {
    actualWebPrompt: isWeb && hasBodyViewport,
    webNaturalFlow: isWeb && hasNaturalFlow,
    nativeNaturalFlow: !isWeb && hasNaturalFlow,
    // Metro resolves WebUserMessageFlow to the web flow on web and to UserMessageFlow on native.
    Flow: hasNativeDriver ? NativeUserMessageFlow : WebUserMessageFlow,
  };
}

export const UserMessage = memo(function UserMessage({
  bodyPresentation,
  forceOrdinaryPreviewExpanded,
  sender,
  onNaturalFlowGeometry,
  naturalFlowMaximumHeight,
  onContentPress,
  contentAccessibilityLabel,
  bubbleWidth,
  hideTextAccessibility,
  contentAction,
  inlineContentAction,
  pinned,
  actionRowBackdrop,
  navigationActions,
  keepActionsVisible,
  previewLines,
  previewExpanded,
  bodyViewportHeight,
  onPreviewOverflowChange,
  serverId,
  agentId,
  messageId,
  message,
  images = EMPTY_MESSAGE_IMAGES,
  attachments = EMPTY_MESSAGE_ATTACHMENTS,
  timestamp,
  capabilities,
  client,
  isFirstInGroup = true,
  isLastInGroup = true,
  isPending = false,
  disableOuterSpacing,
}: UserMessageProps) {
  const isCompact = useIsCompactFormFactor();
  const nativeDriver = useContext(NativeMessagePresentationContext);
  const flowConfiguration = userMessageFlowConfiguration(
    onNaturalFlowGeometry !== undefined,
    bodyViewportHeight !== undefined,
    Boolean(nativeDriver),
  );
  const { actualWebPrompt, webNaturalFlow, nativeNaturalFlow } = flowConfiguration;
  const [isHovered, setIsHovered] = useState(false);
  const [lightboxMetadata, setLightboxMetadata] = useState<UserMessageImageAttachment | null>(null);
  const handleLightboxClose = useCallback(() => setLightboxMetadata(null), []);
  const lightboxSource = useMemo<ImageLightboxSource | null>(
    () => (lightboxMetadata ? { type: "attachment", metadata: lightboxMetadata } : null),
    [lightboxMetadata],
  );
  const resolvedDisableOuterSpacing = useDisableOuterSpacing(disableOuterSpacing);
  const hasText = message.trim().length > 0;
  const compactPreview = previewLines !== undefined && !previewExpanded;
  const showMessageActions = hasText;
  const hasTrailingRow = showMessageActions || !!navigationActions;
  const showTrailingRow = shouldShowUserMessageActions({
    pending: isPending,
    hasActions: hasTrailingRow,
    compact: isCompact,
    hovered: isHovered,
    navigationHeld: keepActionsVisible,
  });
  const formattedTimestamp = useMemo(
    () => formatMessageTimestamp(new Date(timestamp)),
    [timestamp],
  );
  const rewindMutation = useRewindAgentMutation({ serverId, agentId, client, messageId });

  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const getMessageContent = useCallback(() => message, [message]);
  const handleRewind = useCallback(
    (input: { mode: RewindMode; rewoundText: string }) => {
      return rewindMutation.rewindAgent(input);
    },
    [rewindMutation],
  );

  const containerStyle = useMemo(
    () => [
      userMessageStylesheet.container,
      !resolvedDisableOuterSpacing && [
        isFirstInGroup ? userMessageStylesheet.containerFirstInGroup : null,
        isLastInGroup ? userMessageStylesheet.containerLastInGroup : null,
        !isFirstInGroup || !isLastInGroup ? userMessageStylesheet.containerSpacing : null,
      ],
    ],
    [resolvedDisableOuterSpacing, isFirstInGroup, isLastInGroup],
  );
  const contentStyle = useMemo(
    () => [
      userMessageStylesheet.content,
      bodyViewportHeight === undefined || onNaturalFlowGeometry !== undefined
        ? undefined
        : inlineUnistylesStyle({ maxHeight: bodyViewportHeight }),
    ],
    [bodyViewportHeight, onNaturalFlowGeometry],
  );
  const bubbleStyle = useMemo(
    () =>
      resolveUserMessageBubbleStyle(
        bubbleWidth,
        pinned,
        onNaturalFlowGeometry === undefined && (compactPreview || bodyViewportHeight !== undefined),
      ),
    [bubbleWidth, pinned, compactPreview, bodyViewportHeight, onNaturalFlowGeometry],
  );
  // The hit target stays absolute and independent of body layout. Reuse the bubble's
  // actual corners, including its pinned variant, for feedback without clipping children.
  const contentPressCorners = useMemo(() => resolveHighlightCorners(bubbleStyle), [bubbleStyle]);
  const contentPressHighlight = useMemo(
    () => [contentPressCorners, userMessageStylesheet.contentPressFeedback],
    [contentPressCorners],
  );
  const contentPressTargetStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      userMessageStylesheet.contentPressTarget,
      contentPressCorners,
      isWeb && pressed && userMessageStylesheet.contentPressFeedback,
    ],
    [contentPressCorners],
  );
  const trailingRowStyle = useMemo(
    () => [
      userMessageStylesheet.trailingRow,
      actionRowBackdrop && !nativeNaturalFlow
        ? userMessageStylesheet.trailingRowWithBackdrop
        : undefined,
      previewLines === undefined || nativeNaturalFlow
        ? undefined
        : userMessageStylesheet.trailingRowPreview,
      showTrailingRow
        ? userMessageStylesheet.trailingRowVisible
        : userMessageStylesheet.trailingRowHidden,
    ],
    [showTrailingRow, previewLines, actionRowBackdrop, nativeNaturalFlow],
  );

  const attachmentContent = useMemo(
    () => (
      <UserMessageAttachments
        images={images}
        attachments={attachments}
        compact={compactPreview}
        hasText={hasText}
        onOpen={setLightboxMetadata}
      />
    ),
    [images, attachments, compactPreview, hasText],
  );
  const flowRevision = useMemo(
    () => ({ message, images, attachments, isPending, hasTrailingRow }),
    [message, images, attachments, isPending, hasTrailingRow],
  );
  const Bubble = onNaturalFlowGeometry ? NaturalMessageBubble : View;
  const contentTarget = onContentPress ? (
    <PressHighlight
      style={contentPressTargetStyle}
      highlightStyle={contentPressHighlight}
      onPress={onContentPress}
      accessible={false}
      focusable={false}
      aria-hidden
      testID="user-message-content-target"
    />
  ) : null;
  const bubbleContent = (
    <Bubble
      style={bubbleStyle}
      pointerEvents={actualWebPrompt || webNaturalFlow ? "auto" : undefined}
      testID="user-message-bubble"
    >
      {nativeDriver ? (
        <NativeMessageVisibility
          driver={nativeDriver}
          visible="pinned"
          style={StyleSheet.absoluteFill}
        >
          {contentTarget}
        </NativeMessageVisibility>
      ) : (
        contentTarget
      )}
      <UserMessagePreviewContent
        bodyPresentation={bodyPresentation}
        forceExpanded={forceOrdinaryPreviewExpanded}
        action={inlineContentAction}
        compact={compactPreview}
        bounded={bodyViewportHeight !== undefined}
        hasText={hasText}
        attachments={attachmentContent}
      >
        <UserMessageText
          message={message}
          hasText={hasText}
          previewLines={previewLines}
          previewExpanded={previewExpanded}
          onPreviewOverflowChange={onPreviewOverflowChange}
          hideTextAccessibility={hideTextAccessibility}
          onContentPress={onContentPress}
          contentAccessibilityLabel={contentAccessibilityLabel}
        />
      </UserMessagePreviewContent>
      {contentAction}
    </Bubble>
  );
  const trailingBackdrop = useMemo(() => {
    if (nativeDriver) {
      return (
        <NativeMessageVisibility
          driver={nativeDriver}
          visible="pinned"
          style={StyleSheet.absoluteFill}
        >
          {actionRowBackdrop}
        </NativeMessageVisibility>
      );
    }
    return nativeNaturalFlow ? null : actionRowBackdrop;
  }, [nativeDriver, nativeNaturalFlow, actionRowBackdrop]);
  const trailingContent = useMemo(
    () =>
      hasTrailingRow ? (
        <UserMessageTrailingRow
          style={trailingRowStyle}
          backed={Boolean(actionRowBackdrop)}
          backdrop={trailingBackdrop}
          pointerEvents={showTrailingRow ? "auto" : "none"}
          testID="user-message-trailing-row"
        >
          {showMessageActions ? (
            <UserMessageTextActions
              formattedTimestamp={formattedTimestamp}
              capabilities={capabilities}
              messageId={messageId}
              isRewindPending={rewindMutation.isPending}
              message={message}
              onRewind={handleRewind}
              getContent={getMessageContent}
            />
          ) : null}
          {navigationActions}
        </UserMessageTrailingRow>
      ) : null,
    [
      hasTrailingRow,
      trailingRowStyle,
      actionRowBackdrop,
      showTrailingRow,
      trailingBackdrop,
      showMessageActions,
      formattedTimestamp,
      capabilities,
      messageId,
      rewindMutation.isPending,
      message,
      handleRewind,
      getMessageContent,
      navigationActions,
    ],
  );
  const Flow = flowConfiguration.Flow;
  const content = onNaturalFlowGeometry ? (
    <Flow
      bodyPresentation={bodyPresentation}
      driver={nativeDriver}
      trailing={trailingContent}
      controls={inlineContentAction}
      summary={null}
      revision={flowRevision}
      message={message}
      compact={compactPreview}
      bounded={bodyViewportHeight !== undefined}
      maximumHeight={naturalFlowMaximumHeight ?? bodyViewportHeight}
      compactTrailingPadding={compactMessageActionPadding(webNaturalFlow, hasTrailingRow)}
      backdropStyle={bubbleStyle}
      visualBackdrop={actionRowBackdrop}
      onGeometry={onNaturalFlowGeometry}
      onHoverChange={webNaturalFlow ? setIsHovered : undefined}
    >
      {renderMessageSender(sender, serverId)}
      {bubbleContent}
    </Flow>
  ) : (
    <View
      style={contentStyle}
      pointerEvents={actualWebPrompt ? "box-none" : undefined}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      {renderMessageSender(sender, serverId)}
      {bubbleContent}
      {trailingContent}
    </View>
  );
  return (
    <View
      style={containerStyle}
      testID="user-message"
      aria-busy={isPending}
      pointerEvents={onNaturalFlowGeometry ? "box-none" : userMessageHitAllocation(actualWebPrompt)}
    >
      {content}
      <AttachmentLightbox source={lightboxSource} onClose={handleLightboxClose} />
    </View>
  );
});

/** Keep web action content at its ordinary rail width. Pinned padding paints
 * into the existing chat gutter instead of narrowing and rewrapping the content.
 * Native keeps the same single View and the original composed row styles.
 */
function renderMessageSender(
  sender: AgentMessage["sender"] | undefined,
  serverId: string | undefined,
): ReactNode {
  return sender ? <MessageSender sender={sender} serverId={serverId} /> : null;
}
