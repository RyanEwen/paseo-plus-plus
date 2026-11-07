import { memo, useMemo, useContext, type ComponentProps } from "react";
import { UserMessage } from "@/components/message";
import { PromptNavigationActions, PromptNavigationContext } from "./prompt-navigation-actions";

/** Attach viewport-owned navigation without changing the shared message renderer's identity. */
export const PromptUserMessage = memo(function PromptUserMessage({
  timelineMessageId,
  ...props
}: ComponentProps<typeof UserMessage> & { timelineMessageId: string }) {
  const navigation = useContext(PromptNavigationContext);
  const hasNavigation = navigation?.targetIds.includes(timelineMessageId) ?? false;
  const actions = useMemo(
    () => (hasNavigation ? <PromptNavigationActions messageId={timelineMessageId} /> : null),
    [timelineMessageId, hasNavigation],
  );
  return (
    <UserMessage
      {...props}
      navigationActions={actions}
      keepActionsVisible={navigation?.actionVisibleMessageId === timelineMessageId}
    />
  );
});
