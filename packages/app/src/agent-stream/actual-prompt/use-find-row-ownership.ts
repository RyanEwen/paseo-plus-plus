import { useMemo } from "react";
import { getStreamItemMessageId, type StreamItem } from "@/types/stream";
import {
  useChatFindOriginalMessage,
  useChatFindSelectedMessageId,
} from "@/agent-stream/chat-find/selection";

/** Derive Find's temporary original-row owner and the real rows it must retain. */
export function useFindRowOwnership(
  owner: { scope: string } | null,
  agentId: string,
  active: boolean,
  historyVirtualized: readonly StreamItem[],
) {
  const { messageId: originalFindMessageId, select: selectFindOriginalMessage } =
    useChatFindOriginalMessage(owner?.scope ?? agentId, active);
  const selectedFindMessageId = useChatFindSelectedMessageId();
  const chatFindMessageId = originalFindMessageId ?? selectedFindMessageId;
  // Chat find counts and highlights occurrences from the DOM, so every block row of
  // the message it selected has to be mounted even when the scroll window is nowhere
  // near it. Without this a hit in a far paragraph is invisible to the count and Next
  // walks off to the following message.
  const chatFindRowIndexes = useMemo(() => {
    if (!chatFindMessageId) return null;
    const indexes = historyVirtualized.flatMap((item, index) =>
      getStreamItemMessageId(item) === chatFindMessageId ? [index] : [],
    );
    return indexes.length > 0 ? indexes : null;
  }, [chatFindMessageId, historyVirtualized]);
  return { originalFindMessageId, selectFindOriginalMessage, chatFindRowIndexes };
}
