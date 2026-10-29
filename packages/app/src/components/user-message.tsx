import { useTextLink } from "@/hooks/use-text-link";
import { TextPreview } from "@/components/ui/text-preview";
import { UserMessagePreviewContent } from "./user-message-preview-content";
import { UserMessageAttachments } from "./user-message-attachments";
import {
  NaturalMessageBubble,
  NaturalMessageFlowContext,
  UserMessageFlow,
  type NaturalMessageGeometry,
} from "./user-message-flow";
import { WebUserMessageFlow } from "./user-message-web-flow";
import { AttachmentLightbox, type ImageLightboxSource } from "@/components/attachment-lightbox";
import { RewindMenu, type RewindMode } from "@/components/rewind/rewind-menu";
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
import * as React from "react";
import { memo, useCallback, useContext, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Text,
  View,
  type GestureResponderEvent,
  type PressableStateCallbackType,
} from "react-native";
import { PressHighlight } from "@/components/ui/press-highlight";
import { resolveHighlightCorners } from "@/components/ui/press-highlight.shape";
import { NativeMessagePresentationContext } from "./user-message-native-presentation";
import {
  NativeUserMessageFlow,
  NativeMessageSuffixMask,
  NativeMessageVisibility,
} from "./user-message-native-flow";
import { StyleSheet } from "react-native-unistyles";
import {
  useDisableOuterSpacing,
  STREAM_METADATA_FONT_SIZE,
  MESSAGE_TEXT_DATASET,
} from "./message-layout";
import { TurnCopyButton } from "./turn-copy-button";
interface UserMessageProps {
  /** An optional measured viewport retains the one ordinary body's natural flow. */
  onNaturalFlowGeometry?: (geometry: NaturalMessageGeometry | null) => void;
  onContentPress?: (event: GestureResponderEvent) => void;
  contentAccessibilityLabel?: string;
  /** Measured source width keeps the sticky copy's glyph positions aligned at the edge. */
  bubbleWidth?: number;
  hideTextAccessibility?: boolean;
  bubbleRef?: React.Ref<React.ComponentRef<typeof View>>;
  onBubbleLayout?: () => void;
  onBubbleTextLayout?: (event: import("react-native").TextLayoutEvent) => void;
  copyMask?: { prefixHeight: number; expanded: boolean };
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
  suppressed: { opacity: 0 },
  contentPressTarget: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    cursor: "pointer",
  },
  contentPressFeedback: { backgroundColor: theme.colors.interactionHighlight },
  textRegion: { minWidth: 0, flexShrink: 1 },
  textMask: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: theme.colors.userMessageBackground,
  },
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
  copyButton: {
    alignSelf: "center",
    padding: theme.spacing[1],
    paddingTop: theme.spacing[1],
    marginTop: 0,
    marginRight: -theme.spacing[1],
  },
  trailingRow: {
    alignSelf: "flex-end",
    marginTop: theme.spacing[2],
  },
  trailingContent: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 24,
    gap: theme.spacing[2],
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
  timestampText: {
    color: theme.colors.foregroundMuted,
    fontSize: STREAM_METADATA_FONT_SIZE,
  },
}));

function ignorePreviewOverflow(_overflowing: boolean): void {
  return;
}

/** Keep the actual message text mounted while disclosure changes its visible height. */
function UserMessageText({
  message,
  hasText,
  previewLines,
  previewExpanded,
  onPreviewOverflowChange,
  hideTextAccessibility,
  onBubbleTextLayout,
  copyMask,
  onContentPress,
  contentAccessibilityLabel,
}: Pick<
  UserMessageProps,
  | "message"
  | "previewLines"
  | "previewExpanded"
  | "onPreviewOverflowChange"
  | "hideTextAccessibility"
  | "onBubbleTextLayout"
  | "copyMask"
  | "onContentPress"
  | "contentAccessibilityLabel"
> & { hasText: boolean }) {
  const naturalFlow = useContext(NaturalMessageFlowContext);
  const reportTextLayout = useCallback(
    (event: import("react-native").TextLayoutEvent) => {
      naturalFlow?.reportText(event.nativeEvent.lines);
      if (naturalFlow) {
        onPreviewOverflowChange?.(event.nativeEvent.lines.length > (previewLines ?? 1));
      }
      onBubbleTextLayout?.(event);
    },
    [naturalFlow, onBubbleTextLayout, onPreviewOverflowChange, previewLines],
  );
  const textMaskStyle = useMemo(
    () => [
      userMessageStylesheet.textMask,
      inlineUnistylesStyle({ height: copyMask?.prefixHeight ?? 0 }),
    ],
    [copyMask?.prefixHeight],
  );
  const compactPrefixHeight = naturalFlow?.textPrefixHeight;
  const suffixMaskStyle = useMemo(
    () => [
      userMessageStylesheet.textMask,
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
    <View style={userMessageStylesheet.textRegion}>
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
          style={userMessageStylesheet.text}
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
          backgroundStyle={userMessageStylesheet.textMask}
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
      {!!copyMask?.prefixHeight && (
        <View
          style={textMaskStyle}
          pointerEvents="none"
          testID="user-message-prefix-mask"
          aria-hidden
        />
      )}
    </View>
  );
}

/** Expansion transfers painting and accessibility to the full sticky copy. */
function isExpandedPromptCopy(copyMask: UserMessageProps["copyMask"]): boolean {
  return copyMask?.expanded === true;
}

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
  suppressed: boolean;
  pending: boolean;
  hasActions: boolean;
  compact: boolean;
  hovered: boolean;
  navigationHeld: boolean | undefined;
}

function shouldShowUserMessageActions({
  suppressed,
  pending,
  hasActions,
  compact,
  hovered,
  navigationHeld,
}: UserMessageActionVisibility) {
  return (
    !suppressed &&
    !pending &&
    hasActions &&
    areMessageActionsVisible(compact, hovered, navigationHeld)
  );
}

function userMessageHitAllocation(suppressed: boolean, actualWebPrompt: boolean) {
  if (suppressed) return "none";
  if (actualWebPrompt) return "box-none";
  return "auto";
}

/** Select the platform flow and its presentation flags without changing body ownership. */
function userMessageFlowConfiguration(
  hasNaturalFlow: boolean,
  hasBodyViewport: boolean,
  hasNativeDriver: boolean,
) {
  const ordinaryFlow = isWeb ? WebUserMessageFlow : UserMessageFlow;
  return {
    actualWebPrompt: isWeb && hasBodyViewport,
    webNaturalFlow: isWeb && hasNaturalFlow,
    nativeNaturalFlow: !isWeb && hasNaturalFlow,
    Flow: hasNativeDriver ? NativeUserMessageFlow : ordinaryFlow,
  };
}

export const UserMessage = memo(function UserMessage({
  onNaturalFlowGeometry,
  onContentPress,
  contentAccessibilityLabel,
  bubbleWidth,
  hideTextAccessibility,
  bubbleRef,
  onBubbleLayout,
  onBubbleTextLayout,
  copyMask,
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
  const expandedCopy = isExpandedPromptCopy(copyMask);
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
    suppressed: !!copyMask,
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
      expandedCopy ? userMessageStylesheet.suppressed : undefined,
      !resolvedDisableOuterSpacing && [
        isFirstInGroup ? userMessageStylesheet.containerFirstInGroup : null,
        isLastInGroup ? userMessageStylesheet.containerLastInGroup : null,
        !isFirstInGroup || !isLastInGroup ? userMessageStylesheet.containerSpacing : null,
      ],
    ],
    [resolvedDisableOuterSpacing, isFirstInGroup, isLastInGroup, expandedCopy],
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
      ref={bubbleRef}
      onLayout={onBubbleLayout}
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
          onBubbleTextLayout={onBubbleTextLayout}
          copyMask={copyMask}
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
          aria-hidden={!!copyMask}
          accessibilityElementsHidden={!!copyMask}
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
      copyMask,
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
      driver={nativeDriver}
      trailing={trailingContent}
      controls={inlineContentAction}
      summary={null}
      revision={flowRevision}
      message={message}
      compact={compactPreview}
      bounded={bodyViewportHeight !== undefined}
      maximumHeight={bodyViewportHeight}
      backdropStyle={bubbleStyle}
      visualBackdrop={actionRowBackdrop}
      onGeometry={onNaturalFlowGeometry}
      onHoverChange={webNaturalFlow ? setIsHovered : undefined}
    >
      {bubbleContent}
    </Flow>
  ) : (
    <View
      style={contentStyle}
      pointerEvents={actualWebPrompt ? "box-none" : undefined}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      {bubbleContent}
      {trailingContent}
    </View>
  );
  return (
    <View
      style={containerStyle}
      testID="user-message"
      aria-busy={isPending}
      pointerEvents={
        onNaturalFlowGeometry ? "box-none" : userMessageHitAllocation(expandedCopy, actualWebPrompt)
      }
      aria-hidden={expandedCopy}
      accessibilityElementsHidden={expandedCopy}
      importantForAccessibility={expandedCopy ? "no-hide-descendants" : "auto"}
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
function UserMessageTrailingRow({
  backed,
  backdrop,
  style,
  children,
  ...props
}: React.ComponentProps<typeof View> & { backed: boolean; backdrop: ReactNode }) {
  const flow = useContext(NaturalMessageFlowContext);
  const web = flow?.web === true;
  const railWidth = flow?.webRailWidth;
  const preparedWidth = railWidth !== undefined && railWidth > 0;
  const padding = backed ? SPACING[2] : 0;
  const paintStyle = useMemo<React.ComponentProps<typeof View>["style"]>(() => {
    if (!web) return [userMessageStylesheet.trailingContent, style];
    return [
      style,
      {
        maxWidth: preparedWidth ? railWidth + padding * 2 : "100%",
        marginLeft: preparedWidth ? -padding : 0,
        marginRight: preparedWidth ? -padding : 0,
      },
    ];
  }, [web, style, preparedWidth, railWidth, padding]);
  const contentStyle = useMemo<React.ComponentProps<typeof View>["style"]>(
    () => [
      userMessageStylesheet.trailingContent,
      {
        maxWidth: preparedWidth ? railWidth : "100%",
        minWidth: 0,
        flexShrink: 1,
      },
    ],
    [preparedWidth, railWidth],
  );
  if (!web)
    return (
      <View {...props} style={paintStyle}>
        {backdrop}
        {children}
      </View>
    );
  return (
    <View {...props} style={paintStyle}>
      {backdrop}
      <View style={contentStyle} testID="user-message-action-content">
        {children}
      </View>
    </View>
  );
}

/** Keep timestamp, rewind and copy together beside optional prompt navigation. */
function UserMessageTextActions({
  formattedTimestamp,
  capabilities,
  messageId,
  isRewindPending,
  message,
  onRewind,
  getContent,
}: {
  formattedTimestamp: string;
  capabilities?: AgentCapabilityFlags;
  messageId?: string;
  isRewindPending: boolean;
  message: string;
  onRewind: React.ComponentProps<typeof RewindMenu>["onRewind"];
  getContent: () => string;
}) {
  const { t } = useTranslation();
  return (
    <>
      <Text style={userMessageStylesheet.timestampText} testID="user-message-timestamp">
        {formattedTimestamp}
      </Text>
      {capabilities && messageId ? (
        <RewindMenu
          capabilities={capabilities}
          isPending={isRewindPending}
          rewoundText={message}
          onRewind={onRewind}
        />
      ) : null}
      <TurnCopyButton
        getContent={getContent}
        containerStyle={userMessageStylesheet.copyButton}
        accessibilityLabel={t("message.actions.copyMessage")}
      />
    </>
  );
}
