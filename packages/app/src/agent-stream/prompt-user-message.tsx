import { useActualPromptPresentation } from "./use-actual-prompt-presentation";
import { memo, useMemo, useCallback, useContext, type ComponentProps } from "react";
import { UserMessage } from "@/components/prompt-message";
import { PromptNavigationActions, PromptNavigationContext } from "./prompt-navigation-actions";
import { NativeStickyLayoutContext } from "./native-sticky-layout-context";
import { ActualPromptRowsContext, ActualPromptFlowGeometryContext } from "./actual-prompt-rows";
import type { NaturalMessageGeometry } from "@/components/prompt-message/flow-model";
import { useChatFindSelectedMessageId } from "./chat-find/selection";
import { ActualPromptBody } from "./actual-prompt/prompt-body";
import { PromptRowBoundary } from "./actual-prompt/prompt-row-boundary";
import { Text } from "react-native";

/** Attach viewport-owned navigation without changing the shared message renderer's identity. */
export const PromptUserMessage = memo(function PromptUserMessage({
  timelineMessageId,
  ...props
}: ComponentProps<typeof UserMessage> & { timelineMessageId: string }) {
  const presentation = useActualPromptPresentation(timelineMessageId, props);
  const nativeLayout = useContext(NativeStickyLayoutContext);
  const actualRows = useContext(ActualPromptRowsContext);
  const selectedFindMessageId = useChatFindSelectedMessageId();
  const webGeometry = useContext(ActualPromptFlowGeometryContext);
  const reportNaturalGeometry = useCallback(
    (geometry: NaturalMessageGeometry | null) => {
      if (nativeLayout) nativeLayout.publishBody(geometry);
      else webGeometry?.(geometry);
    },
    [nativeLayout, webGeometry],
  );
  const navigation = useContext(PromptNavigationContext);
  const hasNavigation = navigation?.targetIds.includes(timelineMessageId) ?? false;
  const actions = useMemo(
    () => (hasNavigation ? <PromptNavigationActions messageId={timelineMessageId} /> : null),
    [timelineMessageId, hasNavigation],
  );
  // If the sticky presentation fails, this row shows the ordinary message instead, and
  // bare text if even that fails, rather than taking the chat down.
  const bareText = useMemo(() => <Text selectable>{props.message}</Text>, [props.message]);
  const plainMessage = useMemo(
    () => (
      <PromptRowBoundary fallback={bareText}>
        <UserMessage {...props} navigationActions={actions} />
      </PromptRowBoundary>
    ),
    [props, actions, bareText],
  );
  return (
    <ActualPromptBody>
      <PromptRowBoundary fallback={plainMessage}>
        <UserMessage
          {...props}
          navigationActions={actions}
          keepActionsVisible={navigation?.actionVisibleMessageId === timelineMessageId}
          {...presentation}
          bodyPresentation={actualRows ? "actualPrompt" : "ordinaryPreview"}
          forceOrdinaryPreviewExpanded={selectedFindMessageId === timelineMessageId}
          onNaturalFlowGeometry={
            webGeometry || (nativeLayout && actualRows) ? reportNaturalGeometry : undefined
          }
          naturalFlowMaximumHeight={webGeometry ? actualRows?.bodyViewportHeight : undefined}
        />
      </PromptRowBoundary>
    </ActualPromptBody>
  );
});
