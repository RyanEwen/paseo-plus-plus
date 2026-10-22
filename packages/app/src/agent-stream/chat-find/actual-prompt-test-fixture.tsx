import { useCallback, useMemo, useState, type ReactNode, type RefObject } from "react";
import { vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastApiProvider } from "@/contexts/toast-api-context";
import type { StreamItem } from "@/types/stream";
import { ActualPromptRowsProvider } from "../actual-prompt-rows";
import { PromptNavigationContext } from "../prompt-navigation-actions";
import { PromptUserMessage } from "../prompt-user-message";
import { createWebStreamStrategy } from "../strategy-web";
import type { StreamSegmentRenderers, StreamViewportHandle } from "../strategy";

export const ACTUAL_PROMPT_ID = "message-1";
const STREAM_STYLE = {
  height: "100%",
  width: "100%",
  display: "flex",
  flexDirection: "column" as const,
  minHeight: 0,
};
const ANSWER_STYLE = { height: 700 };
const SURROUNDING_TARGET_STYLE = { width: 80, height: 44 };
const toast = { show: vi.fn(), copied: vi.fn(), error: vi.fn() };
const controls = {
  targetIds: [ACTUAL_PROMPT_ID],
  busy: false,
  previousKnownBoundary: true,
  actionVisibleMessageId: ACTUAL_PROMPT_ID,
  activate: vi.fn(),
  reveal: vi.fn(),
};
const answer: StreamItem = {
  kind: "assistant_message",
  id: "answer",
  text: "Response",
  timestamp: new Date(1),
};
function SurroundingAnswer() {
  const [clicks, setClicks] = useState(0);
  const incrementClicks = useCallback(() => setClicks((count) => count + 1), []);
  return (
    <div style={ANSWER_STYLE}>
      <button
        type="button"
        style={SURROUNDING_TARGET_STYLE}
        data-testid="assistant-surrounding-target"
        onClick={incrementClicks}
      >
        Response {clicks}
      </button>
      <span data-testid="assistant-surrounding-text">Selectable surrounding answer</span>
    </div>
  );
}
function renderRow(item: StreamItem) {
  if (item.kind !== "user_message") return <SurroundingAnswer />;
  return (
    <PromptUserMessage
      timelineMessageId={item.id}
      message={item.text}
      timestamp={0}
      disableOuterSpacing
    />
  );
}
const renderers: StreamSegmentRenderers = {
  renderLiveHeadRow: renderRow,
  renderHistoryMountedRow: renderRow,
  renderHistoryVirtualizedRow: renderRow,
  renderLiveAuxiliary: () => null,
};
const nearBottom = vi.fn();
const loadOlder = vi.fn(() => false);

interface Props {
  text: string;
  enabled?: boolean;
  scope?: string;
  viewportRef: RefObject<StreamViewportHandle | null>;
  liveAuxiliary?: ReactNode;
  wrapRow?: (content: ReactNode) => ReactNode;
}

/** Real user renderer and real outer scroll owner; only daemon-independent fixture data. */
function ActualPromptStream({
  text,
  enabled = true,
  scope = "agent:epoch",
  viewportRef,
  liveAuxiliary,
  wrapRow,
}: Props) {
  const strategy = useMemo(() => createWebStreamStrategy({ isMobileBreakpoint: false }), []);
  const streamRenderers = useMemo<StreamSegmentRenderers>(() => {
    const renderContent: StreamSegmentRenderers["renderLiveHeadRow"] = (item) => {
      const content = renderRow(item);
      return wrapRow ? wrapRow(content) : content;
    };
    return {
      ...renderers,
      renderLiveHeadRow: renderContent,
      renderLiveAuxiliary: () => liveAuxiliary ?? null,
    };
  }, [liveAuxiliary, wrapRow]);
  const prompt = useMemo<StreamItem>(
    () => ({ kind: "user_message", id: ACTUAL_PROMPT_ID, text, timestamp: new Date(0) }),
    [text],
  );
  return (
    <div data-chat-find-root="true" style={STREAM_STYLE}>
      <ActualPromptRowsProvider enabled={enabled} scope={scope} availableHeight={320}>
        <PromptNavigationContext.Provider value={enabled ? controls : null}>
          {strategy.render({
            agentId: "agent",
            segments: { historyVirtualized: [], historyMounted: [], liveHead: [prompt, answer] },
            boundary: { hasVirtualizedHistory: false, hasMountedHistory: false, hasLiveHead: true },
            renderers: streamRenderers,
            listEmptyComponent: null,
            viewportRef,
            routeBottomAnchorRequest: null,
            isAuthoritativeHistoryReady: true,
            onNearBottomChange: nearBottom,
            onNearHistoryStart: loadOlder,
            isLoadingOlderHistory: false,
            hasOlderHistory: false,
            olderHistoryProgressKey: null,
            scrollEnabled: true,
            listStyle: null,
            baseListContentContainerStyle: null,
            forwardListContentContainerStyle: null,
            contentMaxWidth: 820,
          })}
        </PromptNavigationContext.Provider>
      </ActualPromptRowsProvider>
    </div>
  );
}

export function ActualPromptTestFixture(props: Props) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <ToastApiProvider api={toast}>
        <ActualPromptStream {...props} />
      </ToastApiProvider>
    </QueryClientProvider>
  );
}
