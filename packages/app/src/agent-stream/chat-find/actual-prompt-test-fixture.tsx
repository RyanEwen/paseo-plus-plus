import { useCallback, useMemo, useState, type ReactNode, type RefObject } from "react";
import { vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastApiProvider } from "@/contexts/toast-api-context";
import type { StreamItem, UserMessageImageAttachment } from "@/types/stream";
import { ActualPromptRowsProvider } from "../actual-prompt-rows";
import { PromptNavigationContext } from "../prompt-navigation-actions";
import { PromptUserMessage } from "../prompt-user-message";
import { createWebStreamStrategy } from "../strategy-web";
import type { StreamRenderInput, StreamSegmentRenderers, StreamViewportHandle } from "../strategy";
import type { PromptNavigationControls } from "../use-prompt-navigation-controls";
import { buildAgentStreamRenderModel } from "../model";
import { createStreamPresentation } from "../presentation";
import {
  mergeRetainedPrompts,
  retainedCanonicalPositions,
  type CanonicalPromptContext,
} from "@/timeline/canonical-prompt-context";
import { useStreamHistoryWindow } from "../use-stream-history-window";

export const ACTUAL_PROMPT_ID = "message-1";
export const ACTUAL_SUCCESSOR_ID = "message-2";
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
  return renderFixtureRow(item, true);
}
function renderFixtureRow(item: StreamItem, disableOuterSpacing: boolean) {
  if (item.kind !== "user_message") return <SurroundingAnswer />;
  return (
    <PromptUserMessage
      timelineMessageId={item.id}
      message={item.text}
      images={item.images}
      timestamp={0}
      disableOuterSpacing={disableOuterSpacing}
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
const EMPTY_OLDER_HISTORY: readonly StreamItem[] = [];
const EMPTY_LOCAL_HISTORY: StreamItem[] = [];
const EMPTY_CONTEXTS: readonly CanonicalPromptContext[] = [];

interface LocalHistoryFixture {
  items: StreamItem[];
  contexts?: readonly CanonicalPromptContext[];
  /** Deny mount-time fill, then admit an actual upward input without delaying its reveal. */
  allowReveal: () => boolean;
  onReveal: () => void;
}

interface Props {
  text: string;
  successorText?: string;
  lastUserOnly?: boolean;
  images?: UserMessageImageAttachment[];
  enabled?: boolean;
  scope?: string;
  viewportRef: RefObject<StreamViewportHandle | null>;
  liveAuxiliary?: ReactNode;
  wrapRow?: (content: ReactNode) => ReactNode;
  /** Materialize one retained prompt in an existing normal or virtual history lane. */
  historyPlacement?: "normal" | "virtual";
  promptAvailable?: boolean;
  /** The displayed prompt is an isolated canonical point, outside the ordinary window. */
  contextOnlyPrompt?: boolean;
  /** Ordinary source rows accepted between the isolated prompt and the existing answer. */
  olderHistory?: readonly StreamItem[];
  onNearHistoryStart?: StreamRenderInput["onNearHistoryStart"];
  /** Exercise the production local window and render model rather than manually choosing rows. */
  localHistory?: LocalHistoryFixture;
  onReadingPositionChange?: StreamRenderInput["onReadingPositionChange"];
  disableOuterSpacing?: boolean;
  /** Hover regressions must not inherit explicit navigation's visibility hold. */
  holdActionsVisible?: boolean;
  onNavigate?: PromptNavigationControls["activate"];
}

/** Reuse canonical presentation, local reveal ordering and the real render model. */
function useLocalHistoryFixture(localHistory: LocalHistoryFixture | undefined) {
  const items = localHistory?.items ?? EMPTY_LOCAL_HISTORY;
  const contexts = localHistory?.contexts ?? EMPTY_CONTEXTS;
  const canonical = useMemo(() => mergeRetainedPrompts(items, contexts), [items, contexts]);
  const present = useMemo(createStreamPresentation, []);
  const presentation = useMemo(
    () =>
      present({
        tail: canonical,
        head: EMPTY_LOCAL_HISTORY,
        transform: undefined,
        level: "overview",
        isTurnActive: false,
      }),
    [canonical, present],
  );
  const retainedPositions = useMemo(
    () => retainedCanonicalPositions(canonical, contexts),
    [canonical, contexts],
  );
  const {
    start,
    hasLocalHistory,
    loadOlder: localLoadOlder,
  } = useStreamHistoryWindow({
    agentId: "agent",
    items: presentation.tail,
    loadRemoteOlder: loadOlder,
  });
  const model = useMemo(
    () =>
      buildAgentStreamRenderModel({
        isTurnActive: false,
        activeTurnStartedAt: null,
        tail: presentation.tail,
        head: presentation.head,
        platform: "web",
        isMobileBreakpoint: false,
        historyStart: start,
        retainedPositions,
      }),
    [presentation.tail, presentation.head, start, retainedPositions],
  );
  const contextOnlyIds = useMemo(
    () =>
      new Set([
        ...mergeRetainedPrompts([], contexts, items).map((item) => item.id),
        ...model.retainedOnlyIds,
      ]),
    [contexts, items, model.retainedOnlyIds],
  );
  const revealLocalHistory = useCallback(() => {
    if (!localHistory?.allowReveal()) return false;
    localHistory.onReveal();
    // Call directly: the real hook publishes its local reveal before its first await.
    return localLoadOlder();
  }, [localHistory, localLoadOlder]);
  if (!localHistory) return {};
  return {
    segments: model.segments,
    boundary: model.boundary,
    contextOnlyIds,
    onNearHistoryStart: revealLocalHistory,
    hasOlderHistory: hasLocalHistory,
    olderHistoryProgressKey: `local:${start}`,
  };
}

/** Real user renderer and real outer scroll owner; only daemon-independent fixture data. */
function ActualPromptStream({
  text,
  successorText,
  lastUserOnly = false,
  images,
  enabled = true,
  scope = "agent:epoch",
  viewportRef,
  liveAuxiliary,
  wrapRow,
  historyPlacement,
  promptAvailable = true,
  contextOnlyPrompt = false,
  olderHistory = EMPTY_OLDER_HISTORY,
  onNearHistoryStart,
  localHistory,
  onReadingPositionChange,
  disableOuterSpacing = true,
  holdActionsVisible = true,
  onNavigate,
}: Props) {
  const strategy = useMemo(() => createWebStreamStrategy({ isMobileBreakpoint: false }), []);
  const streamRenderers = useMemo<StreamSegmentRenderers>(() => {
    const renderContent: StreamSegmentRenderers["renderLiveHeadRow"] = (item) => {
      const content = renderFixtureRow(item, disableOuterSpacing);
      return wrapRow ? wrapRow(content) : content;
    };
    return {
      ...renderers,
      renderLiveHeadRow: renderContent,
      renderHistoryMountedRow: renderContent,
      renderHistoryVirtualizedRow: renderContent,
      renderLiveAuxiliary: () => liveAuxiliary ?? null,
    };
  }, [liveAuxiliary, wrapRow, disableOuterSpacing]);
  const prompt = useMemo<StreamItem>(
    () => ({ kind: "user_message", id: ACTUAL_PROMPT_ID, text, images, timestamp: new Date(0) }),
    [text, images],
  );
  // A real preceding answer admits an ordinary reading position before the first
  // prompt. The successor then closes the actual CSS sticky collision interval.
  const liveHead = useMemo<StreamItem[]>(() => {
    if (lastUserOnly) return [prompt];
    if (successorText === undefined) return [prompt, answer];
    return [
      { ...answer, id: "preceding-answer" },
      prompt,
      answer,
      {
        kind: "user_message",
        id: ACTUAL_SUCCESSOR_ID,
        text: successorText,
        timestamp: new Date(2),
      },
      { ...answer, id: "following-answer", timestamp: new Date(3) },
    ];
  }, [prompt, successorText, lastUserOnly]);
  const contextOnlyIds = useMemo(
    () => new Set(contextOnlyPrompt ? [prompt.id] : []),
    [contextOnlyPrompt, prompt.id],
  );
  const segments = useMemo(() => {
    const history = liveHead.flatMap((item) =>
      item.id === answer.id ? [...olderHistory, item] : [item],
    );
    const rows = promptAvailable ? history : history.filter((item) => item.id !== prompt.id);
    if (historyPlacement === "virtual") {
      return { historyVirtualized: rows, historyMounted: [], liveHead: [] };
    }
    if (historyPlacement === "normal") {
      return { historyVirtualized: [], historyMounted: rows, liveHead: [] };
    }
    return { historyVirtualized: [], historyMounted: [], liveHead: rows };
  }, [liveHead, promptAvailable, prompt.id, historyPlacement, olderHistory]);
  const localHistoryInput = useLocalHistoryFixture(localHistory);
  const navigation = useMemo(() => {
    const current =
      successorText === undefined
        ? controls
        : { ...controls, targetIds: [ACTUAL_PROMPT_ID, ACTUAL_SUCCESSOR_ID] };
    if (holdActionsVisible && !onNavigate) return current;
    return {
      ...current,
      actionVisibleMessageId: holdActionsVisible ? ACTUAL_PROMPT_ID : undefined,
      activate: onNavigate ?? current.activate,
    };
  }, [successorText, holdActionsVisible, onNavigate]);
  return (
    <div data-chat-find-root="true" style={STREAM_STYLE}>
      <ActualPromptRowsProvider enabled={enabled} scope={scope} availableHeight={320}>
        <PromptNavigationContext.Provider value={enabled ? navigation : null}>
          {strategy.render({
            agentId: "agent",
            segments,
            contextOnlyIds,
            boundary: {
              hasVirtualizedHistory: segments.historyVirtualized.length > 0,
              hasMountedHistory: segments.historyMounted.length > 0,
              hasLiveHead: segments.liveHead.length > 0,
            },
            renderers: streamRenderers,
            listEmptyComponent: null,
            viewportRef,
            routeBottomAnchorRequest: null,
            isAuthoritativeHistoryReady: true,
            onNearBottomChange: nearBottom,
            onReadingPositionChange,
            onNearHistoryStart: onNearHistoryStart ?? loadOlder,
            isLoadingOlderHistory: false,
            hasOlderHistory: onNearHistoryStart !== undefined,
            olderHistoryProgressKey: onNearHistoryStart ? `fixture:${olderHistory.length}` : null,
            scrollEnabled: true,
            listStyle: null,
            baseListContentContainerStyle: null,
            forwardListContentContainerStyle: null,
            contentMaxWidth: 820,
            ...localHistoryInput,
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
