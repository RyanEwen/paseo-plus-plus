import { PROMPT_JUMP_TOP_INSET_PX } from "./prompt-jump-settle";
import { uniqueStreamSegments, precedingPromptIndex } from "./actual-row-collection";
import {
  ActualPinnedRowContext,
  ActualPromptRowsContext,
  ActualPromptFlowGeometryContext,
} from "./actual-prompt-rows";
import type { NaturalMessageGeometry } from "@/components/user-message-flow-model";
import {
  getOriginalPromptTop,
  getNaturalPromptRowHeight,
  syncActualPromptPin,
  reconcilePromptFlow,
} from "./actual-prompt-pin.web";
import { resolvePromptHandoffProgress, type PromptHandoff } from "./prompt-handoff";
import React, {
  type CSSProperties,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  defaultRangeExtractor,
  observeElementOffset,
  measureElement as measureVirtualElement,
  useVirtualizer,
  type Range as VirtualRange,
  type Virtualizer,
} from "@tanstack/react-virtual";
import { flushSync } from "react-dom";
import { withUnistyles } from "react-native-unistyles";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useStableEvent } from "@/hooks/use-stable-event";
import type { StreamItem } from "@/types/stream";
import type { Theme } from "@/styles/theme";
import { WEB_SCROLLBAR_SIZE_PX } from "@/styles/web-scrollbar";
import { DomOverlayScrollbar } from "@/components/ui/overlay-scrollbar/dom-overlay-scrollbar";
import { estimateStreamItemHeight } from "./web-virtualization";
import { createReadingAnchor } from "./reading-anchor";
import type { StreamRenderInput, StreamStrategy, StreamViewportHandle } from "./strategy";
import { useRevisedHistoryRows } from "./history-row-revision";
import { createStreamStrategy } from "./strategy";
import {
  abandonHistoryStartPaginationRequest,
  createHistoryStartPaginationState,
  evaluateHistoryStartPagination,
  isHistoryStartLoadingOperation,
  rearmHistoryStartPagination,
  settleHistoryStartPagination,
  type HistoryStartPaginationInput,
  type HistoryStartPaginationTransition,
} from "./history-start-pagination";
import {
  createHistoryStartSettleScheduler,
  type HistoryStartSettleScheduler,
} from "./history-start-settle-scheduler";
import {
  useChatFindOriginalMessage,
  useChatFindSelectedMessageId,
} from "@/agent-stream/chat-find/selection";
import { getStreamItemMessageId } from "./presentation";
import { useScrollToMessage } from "./use-scroll-to-message.web";

interface CreateWebStreamStrategyInput {
  isMobileBreakpoint: boolean;
}

type ScrollBehaviorLike = "auto" | "smooth";

const WEB_BOTTOM_SETTLE_TIMEOUT_MS = 200;
const USER_SCROLL_DELTA_EPSILON = 1;
const BOTTOM_OVERSCROLL_TOLERANCE_PX = 2;
const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 64;
const AUTO_SCROLL_RESUME_THRESHOLD_PX = 1;
const HISTORY_START_SETTLE_FRAMES = 2;
const HISTORY_START_SLOT_HEIGHT_PX = 32;
const CONTENT_PADDING_TOP_PX = 16;
const UPWARD_INPUT_EVIDENCE_TIMEOUT_MS = 100;
const VIRTUALIZER_SCROLL_MARGIN_PX = HISTORY_START_SLOT_HEIGHT_PX + CONTENT_PADDING_TOP_PX;

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

const historyStartSlotStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: HISTORY_START_SLOT_HEIGHT_PX,
  flexShrink: 0,
};

const streamRowsHostStyle: CSSProperties = { position: "relative", width: "100%" };

const streamRowStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "100%",
};

function isScrollContainerNearBottom(
  scrollContainer: Pick<HTMLElement, "scrollTop" | "clientHeight" | "scrollHeight">,
  thresholdPx = AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
): boolean {
  const threshold = Number.isFinite(thresholdPx)
    ? Math.max(0, thresholdPx)
    : AUTO_SCROLL_BOTTOM_THRESHOLD_PX;
  const { scrollTop, clientHeight, scrollHeight } = scrollContainer;
  if (![scrollTop, clientHeight, scrollHeight].every(Number.isFinite)) {
    return true;
  }
  const distanceFromBottom = scrollHeight - clientHeight - scrollTop;
  return distanceFromBottom <= threshold;
}

function isScrollContainerAtBottom(
  scrollContainer: Pick<HTMLElement, "scrollTop" | "clientHeight" | "scrollHeight">,
): boolean {
  return isScrollContainerNearBottom(scrollContainer, AUTO_SCROLL_RESUME_THRESHOLD_PX);
}

function isScrollContainerMeasurable(
  scrollContainer: Pick<HTMLElement, "clientHeight" | "scrollHeight">,
): boolean {
  return scrollContainer.clientHeight > 0 && scrollContainer.scrollHeight > 0;
}

function isEditableEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  const editableRoot = target.closest("input, textarea, [contenteditable]");
  if (!editableRoot) {
    return false;
  }
  const tagName = editableRoot.tagName.toLowerCase();
  if (tagName === "input" || tagName === "textarea") {
    return true;
  }
  return editableRoot.getAttribute("contenteditable")?.toLowerCase() !== "false";
}

function isUpwardViewportScrollKey(event: KeyboardEvent): boolean {
  if (isEditableEventTarget(event.target)) {
    return false;
  }
  return (
    event.key === "ArrowUp" ||
    event.key === "PageUp" ||
    event.key === "Home" ||
    (event.key === " " && event.shiftKey)
  );
}

function canNestedScrollerConsumeInput(
  target: EventTarget | null,
  scrollContainer: HTMLElement,
  direction: number = -1,
): boolean {
  let element = target instanceof Element ? target : null;
  while (element && element !== scrollContainer) {
    if (element instanceof HTMLElement) {
      const overflowY = window.getComputedStyle(element).overflowY;
      const canScroll = overflowY === "auto" || overflowY === "scroll";
      if (
        canScroll &&
        element.scrollHeight > element.clientHeight &&
        (direction < 0
          ? element.scrollTop > 0
          : element.scrollTop < element.scrollHeight - element.clientHeight)
      ) {
        return true;
      }
    }
    element = element.parentElement;
  }
  return false;
}

function isVerticalScrollbarGutterPress(
  event: PointerEvent,
  scrollContainer: HTMLElement,
): boolean {
  if (event.target !== scrollContainer) {
    return false;
  }
  if (scrollContainer.scrollHeight <= scrollContainer.clientHeight) {
    return false;
  }
  const scrollbarWidth = Math.max(
    scrollContainer.offsetWidth - scrollContainer.clientWidth,
    WEB_SCROLLBAR_SIZE_PX,
  );
  const bounds = scrollContainer.getBoundingClientRect();
  return window.getComputedStyle(scrollContainer).direction === "rtl"
    ? event.clientX <= bounds.left + scrollbarWidth
    : event.clientX >= bounds.right - scrollbarWidth;
}

function scrollElementToBottom(
  scrollContainer: HTMLElement,
  behavior: ScrollBehaviorLike = "auto",
): void {
  scrollContainer.scrollTo({
    top: scrollContainer.scrollHeight,
    behavior,
  });
}

function syncNearBottom(
  scrollContainer: HTMLElement | null,
  onNearBottomChange: (value: boolean) => void,
): boolean {
  if (!scrollContainer) {
    onNearBottomChange(true);
    return true;
  }
  const nextValue = isScrollContainerNearBottom(scrollContainer);
  onNearBottomChange(nextValue);
  return nextValue;
}

interface ActiveFollowOutputLayout {
  scrollContainer: HTMLElement | null;
  viewportWidth: number;
  viewportHeight: number;
  activationKey: string;
  isActivationReady: boolean;
  renderLiveAuxiliary: StreamRenderInput["renderers"]["renderLiveAuxiliary"];
  historyMounted: StreamRenderInput["segments"]["historyMounted"];
  historyVirtualized: StreamRenderInput["segments"]["historyVirtualized"];
  liveHead: StreamRenderInput["segments"]["liveHead"];
  virtualTotalSize: number;
}

function activeFollowOutputLayoutsEqual(
  previous: ActiveFollowOutputLayout,
  next: ActiveFollowOutputLayout,
): boolean {
  return (
    previous.scrollContainer === next.scrollContainer &&
    previous.viewportWidth === next.viewportWidth &&
    previous.viewportHeight === next.viewportHeight &&
    previous.activationKey === next.activationKey &&
    previous.isActivationReady === next.isActivationReady &&
    previous.renderLiveAuxiliary === next.renderLiveAuxiliary &&
    previous.historyMounted === next.historyMounted &&
    previous.historyVirtualized === next.historyVirtualized &&
    previous.liveHead === next.liveHead &&
    previous.virtualTotalSize === next.virtualTotalSize
  );
}

interface ObservedViewportGeometry {
  clientWidth: number;
  clientHeight: number;
  scrollWidth: number;
  scrollHeight: number;
}

function getObservedViewportGeometry(scrollContainer: HTMLElement): ObservedViewportGeometry {
  return {
    clientWidth: scrollContainer.clientWidth,
    clientHeight: scrollContainer.clientHeight,
    scrollWidth: scrollContainer.scrollWidth,
    scrollHeight: scrollContainer.scrollHeight,
  };
}

function observedViewportGeometriesEqual(
  previous: ObservedViewportGeometry,
  next: ObservedViewportGeometry,
): boolean {
  return (
    previous.clientWidth === next.clientWidth &&
    previous.clientHeight === next.clientHeight &&
    previous.scrollWidth === next.scrollWidth &&
    previous.scrollHeight === next.scrollHeight
  );
}

function getScrollContainerDistanceFromBottom(
  scrollContainer: Pick<HTMLElement, "scrollTop" | "clientHeight" | "scrollHeight">,
): number {
  return scrollContainer.scrollHeight - scrollContainer.clientHeight - scrollContainer.scrollTop;
}

function isScrollContainerOverscrolledPastBottom(
  scrollContainer: Pick<HTMLElement, "scrollTop" | "clientHeight" | "scrollHeight">,
): boolean {
  return getScrollContainerDistanceFromBottom(scrollContainer) < -BOTTOM_OVERSCROLL_TOLERANCE_PX;
}

// Position updates do not change a row's content. Keep renderer work separate
// from virtual measurements while retaining the same component across lanes.
const StreamRowContent = React.memo(function StreamRowContent({
  item,
  index,
  items,
  render,
}: {
  revision?: StreamRenderInput["liveHeadRowRevision"];
  item: StreamItem;
  index: number;
  items: StreamItem[];
  render: StreamRenderInput["renderers"]["renderHistoryVirtualizedRow"];
}) {
  return render(item, index, items);
});

interface MeasuredStreamRowGeometry {
  width: number;
  height: number;
  /** Last natural publication committed by the existing ordinary measurement owner. */
  promptFlowHeight?: string;
}

interface RowGeometryChange {
  synchronous: boolean;
  natural: boolean;
}

/** The painted child's resize is not evidence that its ordinary allocation changed. */
function hasNaturalRowChanges(
  entries: readonly ResizeObserverEntry[],
  content: HTMLElement,
  measurements: ReadonlyMap<string, MeasuredStreamRowGeometry>,
): boolean {
  const width = content.getBoundingClientRect().width;
  for (const entry of entries) {
    const row = entry.target.closest<HTMLElement>("[data-history-row-id]");
    // Departed cells and retained-only paint never enter the ordinary adapter.
    if (!row || !content.contains(row)) continue;
    const previous = measurements.get(row.dataset.historyRowId!);
    if (!previous || previous.width !== width) return true;
    if (row.matches("[data-actual-prompt-row]")) {
      const flow = row.querySelector<HTMLElement>("[data-actual-prompt-content]")?.dataset
        .promptFlowHeight;
      if (flow !== previous.promptFlowHeight) return true;
      // Before preparation the one body is ordinary layout. Once prepared, only
      // its natural publication owns height; the visual ResizeObserver may run
      // before that publication's matching paint size has been delivered.
      if (flow !== undefined) continue;
    }
    if (previous.height !== getNaturalPromptRowHeight(row)) return true;
  }
  return false;
}

interface ActualPromptFlowOwner {
  scope: string | undefined;
  node: HTMLDivElement | null;
  geometry: NaturalMessageGeometry | null;
}

/** Keep the natural reservation on the untransformed row, while CSS sticky sees
 * only this child's current paint extent. Ref departure retires the exact owner.
 */
function ActualRowContent({
  pinned,
  isPrompt,
  bodyRef,
  onFlowGeometryChange,
  onPaintGeometryChange,
  children,
}: {
  pinned: boolean;
  isPrompt: boolean;
  bodyRef?: React.RefCallback<HTMLDivElement>;
  onFlowGeometryChange(): void;
  onPaintGeometryChange(): void;
  children: React.ReactNode;
}) {
  const scope = useContext(ActualPromptRowsContext)?.scope;
  const owner = useMemo<ActualPromptFlowOwner>(
    () => ({ scope, node: null, geometry: null }),
    [scope],
  );
  const applyGeometry = useCallback(() => {
    const node = owner.node;
    if (!node) return;
    const flow = owner.geometry ? String(owner.geometry.flowHeight) : undefined;
    const visual = owner.geometry ? String(owner.geometry.visualHeight) : undefined;
    const compact =
      owner.geometry?.compactHeight === undefined
        ? undefined
        : String(owner.geometry.compactHeight);
    const bounded =
      owner.geometry?.bounded === undefined ? undefined : String(owner.geometry.bounded);
    const naturalChanged = node.dataset.promptFlowHeight !== flow;
    if (
      !naturalChanged &&
      node.dataset.promptVisualHeight === visual &&
      node.dataset.promptCompactHeight === compact &&
      node.dataset.promptBounded === bounded
    )
      return;
    if (flow === undefined || visual === undefined) {
      delete node.dataset.promptFlowHeight;
      delete node.dataset.promptVisualHeight;
    } else {
      node.dataset.promptFlowHeight = flow;
      node.dataset.promptVisualHeight = visual;
    }
    if (compact === undefined) delete node.dataset.promptCompactHeight;
    else node.dataset.promptCompactHeight = compact;
    if (bounded === undefined) delete node.dataset.promptBounded;
    else node.dataset.promptBounded = bounded;
    if (naturalChanged) onFlowGeometryChange();
    else onPaintGeometryChange();
  }, [owner, onFlowGeometryChange, onPaintGeometryChange]);
  const reportGeometry = useCallback(
    (geometry: NaturalMessageGeometry | null) => {
      owner.geometry = geometry;
      applyGeometry();
    },
    [owner, applyGeometry],
  );
  const registerBody = useCallback(
    (node: HTMLDivElement | null) => {
      owner.node = node;
      if (!node) return;
      applyGeometry();
      const release = bodyRef?.(node);
      return () => {
        if (owner.node === node) owner.node = null;
        if (typeof release === "function") release();
        else bodyRef?.(null);
      };
    },
    [owner, bodyRef, applyGeometry],
  );
  return (
    <div ref={registerBody} data-actual-prompt-content style={streamRowStyle}>
      <ActualPromptFlowGeometryContext.Provider value={isPrompt ? reportGeometry : null}>
        <ActualPinnedRowContext.Provider value={pinned}>{children}</ActualPinnedRowContext.Provider>
      </ActualPromptFlowGeometryContext.Provider>
    </div>
  );
}

/** Derive Find's temporary original-row owner and the real rows it must retain. */
function useFindRowOwnership(
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

const retainedPromptStyle: CSSProperties = {
  ...streamRowStyle,
  position: "absolute",
  left: 0,
  top: 0,
  height: 0,
  overflow: "hidden",
  visibility: "hidden",
  pointerEvents: "none",
  zIndex: 2,
};

interface RetainedPromptPaintInput {
  content: HTMLElement;
  viewport: HTMLElement;
  prompt: StreamItem | undefined;
  ordinary: StreamItem[];
  virtualPrompts: readonly { id: string; top: number }[];
  enabled: boolean;
}

/** Place the one retained body at the paint edge, without claiming an original row top. */
function positionRetainedPrompt({
  content,
  viewport,
  prompt,
  ordinary,
  virtualPrompts,
  enabled,
}: RetainedPromptPaintInput): string | null {
  const row = content.querySelector<HTMLElement>("[data-retained-prompt-row]");
  const host = content.querySelector<HTMLElement>("[data-stream-rows-host]");
  if (!row || !host) return null;
  row.style.visibility = "hidden";
  row.setAttribute("aria-hidden", "true");
  row.dataset.promptPinned = "false";
  if (!enabled || !prompt || row.dataset.retainedPromptRow !== prompt.id) return null;
  const viewportBounds = viewport.getBoundingClientRect();
  const nextIds = new Set(
    ordinary.flatMap((item) =>
      item.kind === "user_message" &&
      item.timelineCursor?.epoch === prompt.timelineCursor?.epoch &&
      item.timelineCursor !== undefined &&
      prompt.timelineCursor !== undefined &&
      item.timelineCursor.seq > prompt.timelineCursor.seq
        ? [item.id]
        : [],
    ),
  );
  let nextTop = Infinity;
  for (const candidate of virtualPrompts) {
    if (nextIds.has(candidate.id)) nextTop = Math.min(nextTop, candidate.top - viewport.scrollTop);
  }
  for (const candidate of content.querySelectorAll<HTMLElement>("[data-actual-prompt-row]")) {
    if (nextIds.has(candidate.dataset.historyRowId!))
      nextTop = Math.min(nextTop, candidate.getBoundingClientRect().top - viewportBounds.top);
  }
  if (nextTop <= 0) return null;
  const body = row.querySelector<HTMLElement>("[data-actual-prompt-content]");
  if (!body) return null;
  const collision = Math.min(0, nextTop - body.getBoundingClientRect().height);
  row.style.top = `${viewportBounds.top - host.getBoundingClientRect().top + collision}px`;
  // Clip all descendant overflow at the actual viewport end, including preparation.
  // This is a paint bound, never a synthetic inline allocation or virtual estimate.
  row.style.height = `${viewport.clientHeight}px`;
  row.style.visibility = "visible";
  row.setAttribute("aria-hidden", "false");
  row.dataset.promptPinned = "true";
  return prompt.id;
}

/** Retained-only paint changes are not transcript mutations for upstream bottom following. */
function isRetainedPromptMutation(record: MutationRecord): boolean {
  const target = record.target instanceof Element ? record.target : record.target.parentElement;
  if (target?.closest("[data-retained-prompt-row]")) return true;
  const changed = [...record.addedNodes, ...record.removedNodes];
  return (
    changed.length > 0 &&
    changed.every((node) => node instanceof Element && node.matches("[data-retained-prompt-row]"))
  );
}

const promptPaintMutationSelector = [
  '[data-testid="user-message-disclosure"]',
  '[data-testid="user-message-content-target"]',
  '[data-testid="user-message-action-backdrop"]',
  '[data-testid="user-message-prefix-mask"]',
  '[data-testid="user-message-suffix-mask"]',
  "[data-user-message-compact-occlusion]",
  "[data-user-message-paint-backdrop]",
].join(",");

/** Only declared sticky paint is excluded; original body mutations still follow. */
function isPromptPaintMutation(record: MutationRecord): boolean {
  if (isRetainedPromptMutation(record)) return true;
  const target = record.target instanceof Element ? record.target : record.target.parentElement;
  if (!target?.closest('[data-testid="user-message"]')) return false;
  if (target.closest(promptPaintMutationSelector)) return true;
  const changed = [...record.addedNodes, ...record.removedNodes];
  return (
    changed.length > 0 &&
    changed.every((node) => node instanceof Element && node.matches(promptPaintMutationSelector))
  );
}

interface RetainedPromptRowInput {
  item: StreamItem | undefined;
  pinnedRowId: string | null;
  onGeometryChange(): void;
  render: StreamRenderInput["renderers"]["renderHistoryMountedRow"];
}

/** Return the same keyed wrapper/child ancestry used by ordinary mounted and virtual rows. */
function renderRetainedPromptRow({
  item,
  pinnedRowId,
  onGeometryChange,
  render,
}: RetainedPromptRowInput) {
  if (!item) return null;
  return (
    <div
      key={item.id}
      data-retained-prompt-row={item.id}
      aria-hidden="true"
      style={retainedPromptStyle}
    >
      <ActualRowContent
        onFlowGeometryChange={onGeometryChange}
        onPaintGeometryChange={onGeometryChange}
        isPrompt
        pinned={pinnedRowId === item.id}
      >
        <StreamRowContent item={item} index={0} items={[item]} render={render} />
      </ActualRowContent>
    </div>
  );
}

function WebStreamViewport(props: StreamRenderInput & { isMobileBreakpoint: boolean }) {
  const {
    segments: inputSegments,
    retainedPrompt,
    contextOnlyIds,
    historyRowRevision,
    liveHeadRowRevision,
    boundary,
    renderers,
    listEmptyComponent,
    viewportRef,
    routeBottomAnchorRequest,
    isAuthoritativeHistoryReady,
    onNearBottomChange,
    onReadingPositionChange,
    onNearHistoryStart,
    isLoadingOlderHistory,
    hasOlderHistory,
    olderHistoryProgressKey,
    scrollEnabled,
    contentMaxWidth,
    isMobileBreakpoint,
  } = props;
  const historyVirtualized = useRevisedHistoryRows(
    inputSegments.historyVirtualized,
    historyRowRevision,
  );
  const historyMounted = useRevisedHistoryRows(inputSegments.historyMounted, historyRowRevision);
  const segments = useMemo(
    () => uniqueStreamSegments({ ...inputSegments, historyVirtualized, historyMounted }),
    [historyMounted, historyVirtualized, inputSegments],
  );
  const actualRows = useContext(ActualPromptRowsContext);
  const [pinnedRowId, setPinnedRowId] = useState<string | null>(null);
  const isActive = useRetainedPanelActive();
  const { originalFindMessageId, selectFindOriginalMessage, chatFindRowIndexes } =
    useFindRowOwnership(actualRows, props.agentId, isActive, segments.historyVirtualized);
  const isActiveRef = useRef(isActive);
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLElement | null>(null);
  const handleScrollContainerRef = useCallback((node: HTMLElement | null) => {
    scrollContainerRef.current = node;
  }, []);
  const handleContentRef = useCallback((node: HTMLElement | null) => {
    contentRef.current = node;
  }, []);
  const [followOutput, setFollowOutputr] = useState(true);
  const followOutputRef = useRef(followOutput);
  const manualReadingRef = useRef(false);
  // The viewport handle depends on this setter. Keep its identity through resize
  // renders so handle cleanup cannot cancel the owner's queued bottom-follow frame.
  const setFollowOutput = useCallback((value: boolean) => {
    followOutputRef.current = value;
    setFollowOutputr(value);
    return value;
  }, []);
  const lastKnownScrollTopRef = useRef(0);
  const mouseScrollGestureRef = useRef<
    | { kind: "scrollbar"; pointerId: number }
    | {
        kind: "autoscroll";
        pointerId: number;
        lastClientY: number;
        hasUpwardEvidence: boolean;
        evidenceExpiryFrame: number | null;
      }
    | null
  >(null);
  const upwardInputEvidenceUntilRef = useRef(0);
  const lastTouchClientYRef = useRef<number | null>(null);
  const pendingAutoScrollFrameRef = useRef<number | null>(null);
  const pendingAutoScrollTimeoutRef = useRef<number | null>(null);
  const historyStartReadyRef = useRef(false);
  const [historyStartPaginationState, setHistoryStartPaginationState] = useState(
    createHistoryStartPaginationState,
  );
  const historyStartPaginationStateRef = useRef(historyStartPaginationState);
  const readingAnchor = useMemo(createReadingAnchor, []);
  const measuredRowHeights = useRef(new Map<string, MeasuredStreamRowGeometry>());
  const historyStartSettleSchedulerRef = useRef<HistoryStartSettleScheduler | null>(null);
  const lastActiveFollowOutputLayoutRef = useRef<ActiveFollowOutputLayout | null>(null);
  const lastObservedViewportGeometryRef = useRef<ObservedViewportGeometry | null>(null);
  const wasFollowOutputLayoutActiveRef = useRef(false);
  const resumedUnchangedLayoutRef = useRef(false);
  const pendingResumeGeometryCheckRef = useRef(false);
  const shouldUseVirtualizer = segments.historyVirtualized.length > 0;
  const {
    renderHistoryVirtualizedRow,
    renderHistoryMountedRow,
    renderLiveHeadRow,
    renderLiveAuxiliary,
  } = renderers;

  isActiveRef.current = isActive;
  followOutputRef.current = followOutput;

  const hasRouteBottomAnchorRequest = routeBottomAnchorRequest !== null;
  const activationKey = routeBottomAnchorRequest?.requestKey ?? props.agentId;
  const isActivationReady = !hasRouteBottomAnchorRequest || isAuthoritativeHistoryReady;

  const virtualUserIndices = useMemo(
    () =>
      segments.historyVirtualized.flatMap((item, index) =>
        item.kind === "user_message" ? [index] : [],
      ),
    [segments.historyVirtualized],
  );
  const rowVirtualizerRef = useRef<Virtualizer<HTMLElement, Element> | null>(null);
  const rangeExtractor = useCallback(
    (range: VirtualRange): number[] => {
      const anchorRowId = readingAnchor.getRowId();
      const anchorIndex = segments.historyVirtualized.findIndex(
        (row) => row.id === anchorRowId && !contextOnlyIds?.has(row.id),
      );
      const container = scrollContainerRef.current;
      // TanStack has computed the new measurements before calling the extractor.
      // Select against the pending anchor correction, before mounting any rows at
      // the stale pre-prepend offset. The DOM correction still belongs to commit.
      const virtualizer = rowVirtualizerRef.current!;
      const measurement = virtualizer.measurementsCache[anchorIndex];
      const correctedOffset =
        container && measurement
          ? readingAnchor.project(container.scrollTop, {
              id: String(measurement.key),
              top: measurement.start,
            })
          : container?.scrollTop;
      let visibleRange = range;
      if (
        container &&
        correctedOffset !== undefined &&
        Math.abs(correctedOffset - container.scrollTop) > 0.5
      ) {
        const first = virtualizer.getVirtualItemForOffset(correctedOffset);
        const last = virtualizer.getVirtualItemForOffset(correctedOffset + container.clientHeight);
        if (first && last)
          visibleRange = { ...range, startIndex: first.index, endIndex: last.index };
      }
      // Retain only the one preceding actual user row outside the ordinary
      // virtual range. Its outer measurement stays at its original position.
      const precedingVirtualPromptIndex =
        actualRows && correctedOffset !== undefined
          ? precedingPromptIndex(virtualUserIndices, virtualizer.measurementsCache, correctedOffset)
          : -1;
      return [
        ...new Set([
          ...defaultRangeExtractor(visibleRange),
          ...(precedingVirtualPromptIndex < 0 ? [] : [precedingVirtualPromptIndex]),
          ...(chatFindRowIndexes ?? []),
          ...(anchorIndex < 0 ? [] : [anchorIndex]),
        ]),
      ].sort((left, right) => left - right);
    },
    [
      actualRows,
      chatFindRowIndexes,
      contextOnlyIds,
      readingAnchor,
      segments.historyVirtualized,
      virtualUserIndices,
    ],
  );
  const virtualOffsetListener = useRef<((offset: number, scrolling: boolean) => void) | null>(null);
  const observeVirtualOffset = useCallback<typeof observeElementOffset>((instance, onOffset) => {
    virtualOffsetListener.current = onOffset;
    const unsubscribe = observeElementOffset(instance, onOffset);
    return () => {
      virtualOffsetListener.current = null;
      unsubscribe?.();
    };
  }, []);
  const contentWidth = contentRef.current?.getBoundingClientRect().width;
  const rowVirtualizer = useVirtualizer({
    count: segments.historyVirtualized.length,
    enabled: shouldUseVirtualizer,
    // Attaching this adapter must start at the viewport's existing physical offset.
    initialOffset: () => scrollContainerRef.current?.scrollTop ?? 0,
    initialRect: {
      width: scrollContainerRef.current?.clientWidth ?? 0,
      height: scrollContainerRef.current?.clientHeight ?? 0,
    },
    getScrollElement: () => scrollContainerRef.current,
    getItemKey: (index: number) => segments.historyVirtualized[index]?.id ?? index,
    estimateSize: (index: number) => {
      const row = segments.historyVirtualized[index];
      const measured = row && measuredRowHeights.current.get(row.id);
      if (measured && measured.width === contentWidth) return measured.height;
      return row ? estimateStreamItemHeight({ item: row, contentMaxWidth }) : 120;
    },
    observeElementOffset: observeVirtualOffset,
    rangeExtractor,
    scrollMargin: VIRTUALIZER_SCROLL_MARGIN_PX,
    overscan: 8,
  });
  rowVirtualizerRef.current = rowVirtualizer;
  // Scroll correction belongs to the viewport's committed layout. The virtualizer
  // otherwise writes scrollTop before React applies its new row positions.
  rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;
  const virtualRows = rowVirtualizer.getVirtualItems();
  const virtualTotalSize = rowVirtualizer.getTotalSize();
  const getHistoryStartPaginationInput = useStableEvent((): HistoryStartPaginationInput | null => {
    const scrollContainer = scrollContainerRef.current;
    if (!isActiveRef.current || !scrollContainer || !isScrollContainerMeasurable(scrollContainer)) {
      return null;
    }
    const bottomAnchorSettled =
      !followOutputRef.current || isScrollContainerNearBottom(scrollContainer);
    return {
      distanceFromHistoryStart: scrollContainer.scrollTop,
      contentHeight: scrollContainer.scrollHeight,
      viewportHeight: scrollContainer.clientHeight,
      hasOlderHistory,
      isLoadingOlderHistory,
      // An explicit jump owns the landing position. Revealing another local
      // page here changes the virtual index before the target has mounted.
      isReady: historyStartReadyRef.current && bottomAnchorSettled && !isJumpSettling(),
      progressKey: olderHistoryProgressKey,
    };
  });
  const applyHistoryStartPaginationTransition = useStableEvent(
    (transition: HistoryStartPaginationTransition) => {
      const previousState = historyStartPaginationStateRef.current;
      historyStartPaginationStateRef.current = transition.state;
      if (transition.state !== previousState) {
        setHistoryStartPaginationState(transition.state);
      }
      if (!transition.shouldLoad || olderHistoryProgressKey === null) {
        return;
      }
      const requestedProgressKey = olderHistoryProgressKey;
      void (async () => {
        const started = await onNearHistoryStart();
        if (started === true) {
          return;
        }
        applyHistoryStartPaginationTransition({
          state: abandonHistoryStartPaginationRequest(
            historyStartPaginationStateRef.current,
            requestedProgressKey,
          ),
          shouldLoad: false,
        });
      })();
    },
  );
  const evaluateHistoryStart = useStableEvent(() => {
    const input = getHistoryStartPaginationInput();
    if (!input) {
      return;
    }
    const transition = evaluateHistoryStartPagination(
      historyStartPaginationStateRef.current,
      input,
    );
    applyHistoryStartPaginationTransition(transition);
  });
  const rearmHistoryStartFromUserIntent = useStableEvent(() => {
    const rearmed = rearmHistoryStartPagination(historyStartPaginationStateRef.current);
    if (rearmed === historyStartPaginationStateRef.current) {
      return;
    }
    historyStartPaginationStateRef.current = rearmed;
    setHistoryStartPaginationState(rearmed);
    evaluateHistoryStart();
  });
  const scheduleHistoryStartPrependSettle = useStableEvent(() => {
    let scheduler = historyStartSettleSchedulerRef.current;
    if (!scheduler) {
      scheduler = createHistoryStartSettleScheduler({
        settleFrames: HISTORY_START_SETTLE_FRAMES,
        requestFrame: (callback) => window.requestAnimationFrame(callback),
        cancelFrame: (frame) => window.cancelAnimationFrame(frame),
        isSettling: () => historyStartPaginationStateRef.current.status === "settling",
        isLoading: () => {
          const input = getHistoryStartPaginationInput();
          return !input || input.isLoadingOlderHistory;
        },
        onSettle: () => {
          const input = getHistoryStartPaginationInput();
          if (!input) {
            return;
          }
          const transition = settleHistoryStartPagination(
            historyStartPaginationStateRef.current,
            input,
          );
          applyHistoryStartPaginationTransition(transition);
        },
      });
      historyStartSettleSchedulerRef.current = scheduler;
    }
    scheduler.schedule();
  });

  const measureVirtualizedRows = useStableEvent(() => {
    let resized = false;
    for (const element of contentRef.current?.querySelectorAll<HTMLElement>(
      "[data-history-row-id][data-index]",
    ) ?? []) {
      const index = Number(element.dataset.index);
      const height = element.matches("[data-actual-prompt-row]")
        ? getNaturalPromptRowHeight(element)
        : measureVirtualElement(element, undefined, rowVirtualizer);
      if (rowVirtualizer.measurementsCache[index]?.size === height) continue;
      rowVirtualizer.resizeItem(index, height);
      resized = true;
    }
    return resized;
  });

  const onRowGeometryChangeRef = useRef<(change: RowGeometryChange) => void>(() => {});
  // Natural publication and visual paint share this owner, but only actual
  // ordinary layout changes may enter measurement/reading reconciliation.
  const onFlowGeometryChange = useCallback(
    () => onRowGeometryChangeRef.current({ synchronous: false, natural: true }),
    [],
  );
  const onPaintGeometryChange = useCallback(
    () => onRowGeometryChangeRef.current({ synchronous: false, natural: false }),
    [],
  );
  const naturalRowObserver = useMemo(
    () =>
      new ResizeObserver((entries) => {
        if (!isActiveRef.current || !contentRef.current) return;
        onRowGeometryChangeRef.current({
          synchronous: true,
          natural: hasNaturalRowChanges(entries, contentRef.current, measuredRowHeights.current),
        });
      }),
    [],
  );
  const observeActualRowBody = useCallback(
    (body: HTMLDivElement | null) => {
      if (!body) return;
      naturalRowObserver.observe(body, { box: "border-box" });
      return () => naturalRowObserver.unobserve(body);
    },
    [naturalRowObserver],
  );
  useEffect(() => () => naturalRowObserver.disconnect(), [naturalRowObserver]);

  const cancelPendingStickToBottom = useCallback(() => {
    const pendingFrame = pendingAutoScrollFrameRef.current;
    if (pendingFrame !== null) {
      pendingAutoScrollFrameRef.current = null;
      window.cancelAnimationFrame(pendingFrame);
    }
    const pendingTimeout = pendingAutoScrollTimeoutRef.current;
    if (pendingTimeout !== null) {
      pendingAutoScrollTimeoutRef.current = null;
      window.clearTimeout(pendingTimeout);
    }
  }, []);

  const clearMouseScrollGesture = useCallback(() => {
    const gesture = mouseScrollGestureRef.current;
    const evidenceExpiryFrame = gesture?.kind === "autoscroll" ? gesture.evidenceExpiryFrame : null;
    if (evidenceExpiryFrame !== null && evidenceExpiryFrame !== undefined) {
      window.cancelAnimationFrame(evidenceExpiryFrame);
    }
    mouseScrollGestureRef.current = null;
  }, []);

  const clearUpwardInputEvidence = useCallback(() => {
    upwardInputEvidenceUntilRef.current = 0;
  }, []);

  const markUpwardInputEvidence = useCallback(() => {
    upwardInputEvidenceUntilRef.current =
      window.performance.now() + UPWARD_INPUT_EVIDENCE_TIMEOUT_MS;
  }, []);

  useLayoutEffect(() => {
    if (isActive) {
      return;
    }
    cancelPendingStickToBottom();
    historyStartSettleSchedulerRef.current?.cancel();
    clearMouseScrollGesture();
    clearUpwardInputEvidence();
    lastTouchClientYRef.current = null;
  }, [cancelPendingStickToBottom, clearMouseScrollGesture, clearUpwardInputEvidence, isActive]);

  const scrollMessagesToBottom = useCallback(
    (behavior: ScrollBehaviorLike = "auto") => {
      const scrollContainer = scrollContainerRef.current;
      if (
        !isActiveRef.current ||
        !scrollContainer ||
        !isScrollContainerMeasurable(scrollContainer)
      ) {
        return;
      }
      if (isScrollContainerOverscrolledPastBottom(scrollContainer)) {
        return;
      }
      scrollElementToBottom(scrollContainer, behavior);
      lastKnownScrollTopRef.current = scrollContainer.scrollTop;
      syncNearBottom(scrollContainer, onNearBottomChange);
      evaluateHistoryStart();
    },
    [evaluateHistoryStart, onNearBottomChange],
  );

  const scheduleStickToBottom = useCallback(() => {
    if (!isActiveRef.current) {
      return;
    }
    const scrollContainer = scrollContainerRef.current;
    if (scrollContainer && isScrollContainerOverscrolledPastBottom(scrollContainer)) {
      return;
    }
    if (pendingAutoScrollFrameRef.current !== null) {
      return;
    }
    pendingAutoScrollFrameRef.current = window.requestAnimationFrame(() => {
      pendingAutoScrollFrameRef.current = null;
      if (!isActiveRef.current || !followOutputRef.current) {
        return;
      }
      scrollMessagesToBottom("auto");
    });
  }, [scrollMessagesToBottom]);

  const forceStickToBottom = useCallback(() => {
    cancelPendingStickToBottom();
    scrollMessagesToBottom("auto");
    scheduleStickToBottom();
  }, [cancelPendingStickToBottom, scheduleStickToBottom, scrollMessagesToBottom]);

  // Rows are laid out in DOM order, virtualized block first, so the first row whose bottom
  // clears the reading line is the one the reader is looking at.
  const updatePinnedRow = useStableEvent(() => {
    const container = scrollContainerRef.current;
    const content = contentRef.current;
    if (!container || !content || !isActiveRef.current) return;
    const widget = content
      .closest('[data-chat-find-root="true"]')
      ?.querySelector<HTMLElement>('[data-chat-find-widget="true"]');
    const clearance = widget ? widget.getBoundingClientRect().height + 8 : 0;
    actualRows?.reportViewportHeight(
      Math.max(0, container.clientHeight - clearance - PROMPT_JUMP_TOP_INSET_PX),
    );
    reconcilePromptFlow(content, actualRows !== null);
    const virtualPrompts = virtualUserIndices.flatMap((index) => {
      const item = segments.historyVirtualized[index];
      const measurement = rowVirtualizer.measurementsCache[index];
      return item && measurement ? [{ id: item.id, top: measurement.start }] : [];
    });
    const host = content.querySelector<HTMLElement>("[data-stream-rows-host]");
    const virtualEnd = host
      ? host.getBoundingClientRect().top -
        container.getBoundingClientRect().top +
        container.scrollTop +
        rowVirtualizer.getTotalSize()
      : 0;
    const retained = positionRetainedPrompt({
      content,
      viewport: container,
      prompt: retainedPrompt,
      ordinary: [...segments.historyVirtualized, ...segments.historyMounted, ...segments.liveHead],
      virtualPrompts,
      enabled:
        actualRows !== null && !isJumpSettling() && originalFindMessageId !== retainedPrompt?.id,
    });
    const next = syncActualPromptPin(
      content,
      container,
      actualRows !== null,
      virtualPrompts,
      virtualEnd,
      originalFindMessageId,
      retained !== null,
    );
    const owner = retained ?? next;
    setPinnedRowId((current) => (current === owner ? current : owner));
  });

  const onRetainedFlowGeometryChange = useCallback(() => updatePinnedRow(), [updatePinnedRow]);

  const reportReadingPosition = useStableEvent(() => {
    updatePinnedRow();
    if (!isActiveRef.current) {
      return;
    }
    if (!onReadingPositionChange) {
      return;
    }
    const scrollContainer = scrollContainerRef.current;
    const contentNode = contentRef.current;
    if (!scrollContainer || !contentNode) {
      onReadingPositionChange({
        rowId: null,
        visibleUserIds: [],
        navigating: false,
        following: followOutputRef.current,
        manual: manualReadingRef.current,
      });
      return;
    }
    const viewport = scrollContainer.getBoundingClientRect();
    if (viewport.width <= 0 || viewport.height <= 0) return;
    const visibleUsers: string[] = [];
    const userHandoffs: PromptHandoff[] = [];
    for (const bubble of props.trackPromptHandoff === false
      ? []
      : contentNode.querySelectorAll<HTMLElement>('[data-testid="user-message"]')) {
      if (bubble.closest("[data-retained-prompt-row]")) continue;
      const body = bubble.querySelector<HTMLElement>('[data-testid="user-message-bubble"]');
      const renderedBounds = (body ?? bubble).getBoundingClientRect();
      const originalTop = getOriginalPromptTop(body ?? bubble);
      const bounds = {
        ...renderedBounds,
        top: originalTop,
        bottom: originalTop + renderedBounds.height,
        width: renderedBounds.width,
        height: renderedBounds.height,
        left: renderedBounds.left,
      };
      const id = bubble.closest<HTMLElement>("[data-message-id]")?.dataset.messageId;
      if (id && bounds.width > 0 && bounds.height > 0) {
        if (bounds.bottom > viewport.top && bounds.top < viewport.bottom) visibleUsers.push(id);
        const progress = resolvePromptHandoffProgress(bounds.top - viewport.top);
        const { prefixHeightOne, prefixHeightTwo } = measurePromptTextPrefix(bubble);
        userHandoffs.push({
          id,
          progress,
          top: bounds.top - viewport.top,
          left: bounds.left - viewport.left,
          width: bounds.width,
          height: bounds.height,
          viewportWidth: viewport.width,
          prefixHeightOne,
          prefixHeightTwo,
        });
      }
    }
    onReadingPositionChange({
      viewportWidth: viewport.width,
      rowId: readingAnchor.getReadingRowId(scrollContainer.scrollTop),
      visibleUserIds: visibleUsers,
      userHandoffs,
      navigating: isJumpSettling(),
      following: followOutputRef.current,
      manual: manualReadingRef.current,
    });
  });

  const updateScrollMetrics = useCallback(() => {
    if (!isActiveRef.current) {
      return;
    }
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) {
      onNearBottomChange(true);
      return;
    }
    syncNearBottom(scrollContainer, onNearBottomChange);
    reportReadingPosition();
  }, [onNearBottomChange, reportReadingPosition]);

  const { isJumpSettling, scrollToMessage, cancelScrollToMessage } = useScrollToMessage({
    onSettled: () => reportReadingPosition(),
    onStarted: () => {
      manualReadingRef.current = false;
    },
    active: isActive,
    scrollContainerRef,
    rowVirtualizer,
    historyVirtualized: segments.historyVirtualized,
    cancelPendingStickToBottom,
    setFollowOutput,
    onNearBottomChange,
  });

  const reconcileReadingPosition = useStableEvent(() => {
    const container = scrollContainerRef.current;
    const content = contentRef.current;
    if (!isActiveRef.current || !container || !content) return;
    reconcilePromptFlow(content, actualRows !== null);
    const viewportTop = container.getBoundingClientRect().top;
    const scrollTop = container.scrollTop;
    const width = content.getBoundingClientRect().width;
    // Measure every mounted row, including the isolated prompt's full reservation.
    // Only ordinary window rows may own a prepend correction across an unloaded gap.
    const rows = Array.from(
      content.querySelectorAll<HTMLElement>("[data-history-row-id]"),
      (element) => {
        const bounds = element.getBoundingClientRect();
        const id = element.dataset.historyRowId!;
        const naturalHeight = getNaturalPromptRowHeight(element);
        measuredRowHeights.current.set(id, {
          width,
          height: naturalHeight,
          promptFlowHeight: element.querySelector<HTMLElement>("[data-actual-prompt-content]")
            ?.dataset.promptFlowHeight,
        });
        return {
          id,
          top: bounds.top - viewportTop + scrollTop,
          height: naturalHeight,
        };
      },
    ).filter((row) => !contextOnlyIds?.has(row.id));
    const anchorRowId = readingAnchor.getRowId();
    if (anchorRowId !== null && contextOnlyIds?.has(anchorRowId)) readingAnchor.reset();
    const shouldAnchor = !followOutputRef.current && !isJumpSettling();
    if (!shouldAnchor) readingAnchor.reset();
    const correctedTop = readingAnchor.reconcile(container.scrollTop, rows);
    if (!shouldAnchor) {
      readingAnchor.reset();
      return;
    }
    if (Math.abs(correctedTop - container.scrollTop) > 0.5) {
      container.scrollTop = correctedTop;
      lastKnownScrollTopRef.current = container.scrollTop;
      // The DOM scroll event arrives later. Fill the corrected virtual range in
      // this layout so the reader does not get a frame containing only the pin.
      virtualOffsetListener.current?.(container.scrollTop, false);
    }
  });

  onRowGeometryChangeRef.current = ({ synchronous, natural }) => {
    if (!isActiveRef.current) return;
    if (!natural) {
      updatePinnedRow();
      return;
    }
    const content = contentRef.current;
    if (content) reconcilePromptFlow(content, actualRows !== null);
    if (synchronous)
      flushSync(() => {
        measureVirtualizedRows();
      });
    else if (measureVirtualizedRows()) return;
    reconcileReadingPosition();
    updatePinnedRow();
    updateScrollMetrics();
    if (followOutputRef.current) scheduleStickToBottom();
  };

  // Apply row positions and their scroll correction in the same paint, including
  // the ordinary-to-virtualized handoff and measurements of newly mounted rows.
  useLayoutEffect(() => {
    // Commit positions for every resized row before accepting reading geometry.
    // Child layout can change during this commit, ahead of ResizeObserver delivery.
    if (!isActive || measureVirtualizedRows()) return;
    reconcileReadingPosition();
    updatePinnedRow();
  }, [
    updatePinnedRow,
    originalFindMessageId,
    retainedPrompt,
    actualRows?.scope,
    contentWidth,
    contextOnlyIds,
    isActive,
    segments,
    virtualRows,
    measureVirtualizedRows,
    reconcileReadingPosition,
  ]);

  const stopFollowingOutputFromUserIntent = useStableEvent(() => {
    manualReadingRef.current = true;
    cancelPendingStickToBottom();
    if (followOutputRef.current) {
      setFollowOutput(false);
    }
    rearmHistoryStartFromUserIntent();
  });

  const handleDomScroll = useCallback(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!isActiveRef.current || !scrollContainer || !isScrollContainerMeasurable(scrollContainer)) {
      return;
    }

    const currentScrollTop = scrollContainer.scrollTop;
    const isAtBottom = isScrollContainerAtBottom(scrollContainer);
    const scrolledUp = currentScrollTop < lastKnownScrollTopRef.current - USER_SCROLL_DELTA_EPSILON;
    const scrolledDown =
      currentScrollTop > lastKnownScrollTopRef.current + USER_SCROLL_DELTA_EPSILON;
    const mouseGesture = mouseScrollGestureRef.current;
    const hasUpwardInputEvidence =
      mouseGesture?.kind === "scrollbar" ||
      (mouseGesture?.kind === "autoscroll" && mouseGesture.hasUpwardEvidence) ||
      window.performance.now() < upwardInputEvidenceUntilRef.current;

    if (!followOutputRef.current && isAtBottom && scrolledDown && !isJumpSettling()) {
      setFollowOutput(true);
    } else if (followOutputRef.current && scrolledUp && hasUpwardInputEvidence) {
      stopFollowingOutputFromUserIntent();
    }

    lastKnownScrollTopRef.current = currentScrollTop;
    if (!followOutputRef.current && !isJumpSettling() && (scrolledUp || scrolledDown)) {
      readingAnchor.scroll(currentScrollTop);
    }
    updateScrollMetrics();
    evaluateHistoryStart();
  }, [
    evaluateHistoryStart,
    isJumpSettling,
    readingAnchor,
    stopFollowingOutputFromUserIntent,
    setFollowOutput,
    updateScrollMetrics,
  ]);

  useEffect(() => {
    const initialHistoryStartState = createHistoryStartPaginationState();
    historyStartPaginationStateRef.current = initialHistoryStartState;
    setHistoryStartPaginationState(initialHistoryStartState);
    readingAnchor.reset();
    const frame = window.requestAnimationFrame(() => {
      historyStartReadyRef.current = true;
      evaluateHistoryStart();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      historyStartReadyRef.current = false;
      historyStartSettleSchedulerRef.current?.cancel();
      historyStartSettleSchedulerRef.current = null;
    };
  }, [evaluateHistoryStart, props.agentId, readingAnchor]);

  useLayoutEffect(() => {
    if (!isActiveRef.current || !isActivationReady) {
      return;
    }
    if (hasRouteBottomAnchorRequest && !followOutputRef.current) {
      return;
    }
    setFollowOutput(true);
    forceStickToBottom();
    const timeout = window.setTimeout(() => {
      if (!followOutputRef.current) {
        return;
      }
      const scrollContainer = scrollContainerRef.current;
      if (!scrollContainer) {
        return;
      }
      if (isScrollContainerNearBottom(scrollContainer)) {
        return;
      }
      scheduleStickToBottom();
    }, WEB_BOTTOM_SETTLE_TIMEOUT_MS);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [
    activationKey,
    forceStickToBottom,
    hasRouteBottomAnchorRequest,
    setFollowOutput,
    isActivationReady,
    scheduleStickToBottom,
  ]);

  // Following output is a layout invariant: rows, footer, and bottom offset must
  // reach the browser in the same paint.
  useLayoutEffect(() => {
    const layout: ActiveFollowOutputLayout = {
      scrollContainer: scrollContainerRef.current,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      activationKey,
      isActivationReady,
      renderLiveAuxiliary,
      historyMounted: segments.historyMounted,
      historyVirtualized: segments.historyVirtualized,
      liveHead: segments.liveHead,
      virtualTotalSize,
    };
    const resumedUnchangedLayout = Boolean(
      isActive &&
      !wasFollowOutputLayoutActiveRef.current &&
      lastActiveFollowOutputLayoutRef.current &&
      activeFollowOutputLayoutsEqual(lastActiveFollowOutputLayoutRef.current, layout),
    );
    resumedUnchangedLayoutRef.current = resumedUnchangedLayout;
    pendingResumeGeometryCheckRef.current = resumedUnchangedLayout;
    wasFollowOutputLayoutActiveRef.current = isActive;
    if (!isActive) {
      return;
    }
    lastActiveFollowOutputLayoutRef.current = layout;
    if (!followOutputRef.current || resumedUnchangedLayout) return;
    cancelPendingStickToBottom();
    scrollMessagesToBottom("auto");
  }, [
    activationKey,
    cancelPendingStickToBottom,
    isActive,
    isActivationReady,
    renderLiveAuxiliary,
    scrollMessagesToBottom,
    segments.historyMounted,
    segments.historyVirtualized,
    segments.liveHead,
    virtualTotalSize,
  ]);

  useEffect(() => {
    if (!isActive) {
      return;
    }
    const resumedUnchangedLayout = resumedUnchangedLayoutRef.current;
    resumedUnchangedLayoutRef.current = false;
    if (!resumedUnchangedLayout) {
      updateScrollMetrics();
    }
    evaluateHistoryStart();
    if (historyStartPaginationStateRef.current.status === "settling") {
      scheduleHistoryStartPrependSettle();
    }
  }, [
    evaluateHistoryStart,
    hasOlderHistory,
    isActive,
    isLoadingOlderHistory,
    olderHistoryProgressKey,
    scheduleHistoryStartPrependSettle,
    segments.historyMounted.length,
    segments.historyVirtualized.length,
    segments.liveHead.length,
    updateScrollMetrics,
    virtualTotalSize,
  ]);

  useLayoutEffect(() => {
    if (!isActive) {
      return;
    }
    const scrollContainer = scrollContainerRef.current;
    const contentNode = contentRef.current;
    if (!scrollContainer || typeof ResizeObserver === "undefined") {
      return;
    }

    if (!pendingResumeGeometryCheckRef.current) {
      updateScrollMetrics();
      evaluateHistoryStart();
    }
    const observer = new ResizeObserver(() => {
      flushSync(() => {
        measureVirtualizedRows();
      });
      const nextGeometry = getObservedViewportGeometry(scrollContainer);
      if (pendingResumeGeometryCheckRef.current) {
        pendingResumeGeometryCheckRef.current = false;
        reportReadingPosition();
        const previousGeometry = lastObservedViewportGeometryRef.current;
        lastObservedViewportGeometryRef.current = nextGeometry;
        if (previousGeometry && observedViewportGeometriesEqual(previousGeometry, nextGeometry)) {
          return;
        }
      } else {
        lastObservedViewportGeometryRef.current = nextGeometry;
      }
      reconcileReadingPosition();
      if (historyStartPaginationStateRef.current.status === "settling") {
        scheduleHistoryStartPrependSettle();
      }
      updateScrollMetrics();
      evaluateHistoryStart();
      if (!followOutputRef.current) {
        return;
      }
      // ResizeObserver runs before paint. Following in the next frame exposes
      // the newly grown row at the old offset for one painted frame.
      forceStickToBottom();
    });
    observer.observe(scrollContainer);
    if (contentNode) {
      observer.observe(contentNode);
    }
    // Paced reveal commits inside a message without rerendering this viewport.
    // Observe those commits too, so the next frame sees the grown content at the
    // bottom instead of waiting for the resize notification after animation frames.
    const contentChanges = new MutationObserver((records) => {
      if (records.every(isPromptPaintMutation)) return;
      if (isActiveRef.current && followOutputRef.current) forceStickToBottom();
    });
    if (contentNode)
      contentChanges.observe(contentNode, { childList: true, characterData: true, subtree: true });
    return () => {
      observer.disconnect();
      contentChanges.disconnect();
    };
  }, [
    reconcileReadingPosition,
    evaluateHistoryStart,
    isActive,
    reportReadingPosition,
    scheduleHistoryStartPrependSettle,
    forceStickToBottom,
    updateScrollMetrics,
    measureVirtualizedRows,
  ]);

  useLayoutEffect(() => {
    if (!isActive) {
      return;
    }
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) {
      return;
    }

    const markUpwardViewportInput = () => {
      markUpwardInputEvidence();
      if (scrollContainer.scrollTop <= USER_SCROLL_DELTA_EPSILON) {
        rearmHistoryStartFromUserIntent();
      }
    };
    const markManualReading = () => {
      manualReadingRef.current = true;
      reportReadingPosition();
    };
    const handleWheel = (event: WheelEvent) => {
      if (
        event.ctrlKey ||
        event.deltaY === 0 ||
        canNestedScrollerConsumeInput(event.target, scrollContainer, event.deltaY)
      )
        return;
      if (event.deltaY < 0) markUpwardViewportInput();
      markManualReading();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableEventTarget(event.target)) return;
      const upward = isUpwardViewportScrollKey(event);
      const downward = ["ArrowDown", "PageDown", "End", " "].includes(event.key);
      if (!upward && !downward) return;
      if (canNestedScrollerConsumeInput(event.target, scrollContainer, upward ? -1 : 1)) return;
      if (upward) markUpwardViewportInput();
      markManualReading();
    };
    const handlePointerDown = (event: PointerEvent) => {
      clearMouseScrollGesture();
      if (
        event.pointerType !== "mouse" ||
        !event.isPrimary ||
        (event.button !== 0 && event.button !== 1) ||
        isEditableEventTarget(event.target)
      ) {
        return;
      }
      if (event.button === 0) {
        if (isVerticalScrollbarGutterPress(event, scrollContainer)) {
          mouseScrollGestureRef.current = { kind: "scrollbar", pointerId: event.pointerId };
          markManualReading();
        }
        return;
      }
      mouseScrollGestureRef.current = {
        kind: "autoscroll",
        pointerId: event.pointerId,
        lastClientY: event.clientY,
        hasUpwardEvidence: false,
        evidenceExpiryFrame: null,
      };
    };
    const handlePointerMove = (event: PointerEvent) => {
      const gesture = mouseScrollGestureRef.current;
      if (!gesture || gesture.kind !== "autoscroll" || gesture.pointerId !== event.pointerId) {
        return;
      }
      if (Math.abs(event.clientY - gesture.lastClientY) > USER_SCROLL_DELTA_EPSILON)
        markManualReading();
      if (event.clientY < gesture.lastClientY - USER_SCROLL_DELTA_EPSILON) {
        gesture.hasUpwardEvidence = true;
        if (gesture.evidenceExpiryFrame !== null) {
          window.cancelAnimationFrame(gesture.evidenceExpiryFrame);
        }
        gesture.evidenceExpiryFrame = window.requestAnimationFrame(() => {
          if (mouseScrollGestureRef.current === gesture) {
            mouseScrollGestureRef.current = null;
          }
        });
      }
      gesture.lastClientY = event.clientY;
    };
    const handlePointerEnd = (event: PointerEvent) => {
      const gesture = mouseScrollGestureRef.current;
      if (gesture?.pointerId === event.pointerId && gesture.kind === "scrollbar") {
        clearMouseScrollGesture();
      }
    };
    const handlePointerCancel = (event: PointerEvent) => {
      if (mouseScrollGestureRef.current?.pointerId === event.pointerId) {
        clearMouseScrollGesture();
      }
    };
    const handleTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch) {
        return;
      }
      lastTouchClientYRef.current = touch.clientY;
    };
    const handleTouchMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch) {
        return;
      }
      const previousTouchY = lastTouchClientYRef.current;
      const delta = previousTouchY === null ? 0 : previousTouchY - touch.clientY;
      if (
        Math.abs(delta) > 1 &&
        !canNestedScrollerConsumeInput(event.target, scrollContainer, delta)
      ) {
        if (delta < 0) markUpwardViewportInput();
        markManualReading();
      }
      lastTouchClientYRef.current = touch.clientY;
    };
    const handleTouchEnd = () => {
      lastTouchClientYRef.current = null;
    };

    // Read user movement before the virtualizer's bubbling listener flushes a
    // layout correction. Scroll events reuse the last committed row geometry.
    scrollContainer.addEventListener("scroll", handleDomScroll, { passive: true, capture: true });
    scrollContainer.addEventListener("wheel", handleWheel, { passive: true });
    scrollContainer.addEventListener("keydown", handleKeyDown, { passive: true });
    scrollContainer.addEventListener("pointerdown", handlePointerDown, { passive: true });
    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    window.addEventListener("pointerup", handlePointerEnd, { passive: true });
    window.addEventListener("pointercancel", handlePointerCancel, { passive: true });
    window.addEventListener("blur", clearMouseScrollGesture);
    scrollContainer.addEventListener("touchstart", handleTouchStart, { passive: true });
    scrollContainer.addEventListener("touchmove", handleTouchMove, { passive: true });
    scrollContainer.addEventListener("touchend", handleTouchEnd, { passive: true });
    scrollContainer.addEventListener("touchcancel", handleTouchEnd, { passive: true });

    return () => {
      scrollContainer.removeEventListener("scroll", handleDomScroll, true);
      scrollContainer.removeEventListener("wheel", handleWheel);
      scrollContainer.removeEventListener("keydown", handleKeyDown);
      scrollContainer.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerCancel);
      window.removeEventListener("blur", clearMouseScrollGesture);
      scrollContainer.removeEventListener("touchstart", handleTouchStart);
      scrollContainer.removeEventListener("touchmove", handleTouchMove);
      scrollContainer.removeEventListener("touchend", handleTouchEnd);
      scrollContainer.removeEventListener("touchcancel", handleTouchEnd);
      clearUpwardInputEvidence();
    };
  }, [
    clearMouseScrollGesture,
    clearUpwardInputEvidence,
    handleDomScroll,
    isActive,
    markUpwardInputEvidence,
    rearmHistoryStartFromUserIntent,
    reportReadingPosition,
    stopFollowingOutputFromUserIntent,
  ]);

  useEffect(() => {
    const handle: StreamViewportHandle = {
      focus: () => scrollContainerRef.current?.focus({ preventScroll: true }),
      scrollToBottom: () => {
        cancelScrollToMessage();
        setFollowOutput(true);
        cancelPendingStickToBottom();
        forceStickToBottom();
      },
      prepareForViewportChange: () => {
        if (!followOutputRef.current) {
          return;
        }
        scheduleStickToBottom();
      },
      expandMessageForFind: selectFindOriginalMessage,
      scrollToMessage,
      cancelMessageScroll: cancelScrollToMessage,
    };
    viewportRef.current = handle;
    return () => {
      if (viewportRef.current === handle) {
        viewportRef.current = null;
      }
      cancelPendingStickToBottom();
    };
  }, [
    cancelPendingStickToBottom,
    forceStickToBottom,
    selectFindOriginalMessage,
    cancelScrollToMessage,
    scheduleStickToBottom,
    scrollToMessage,
    setFollowOutput,
    viewportRef,
  ]);

  const contentContainerStyle = useMemo((): CSSProperties => {
    return {
      display: "flex",
      flexDirection: "column",
      minHeight: "100%",
      paddingTop: CONTENT_PADDING_TOP_PX,
      paddingBottom: 16,
      paddingLeft: isMobileBreakpoint ? 8 : 16,
      paddingRight: isMobileBreakpoint ? 8 : 16,
      boxSizing: "border-box",
    };
  }, [isMobileBreakpoint]);
  const scrollContainerStyle = useMemo((): CSSProperties => {
    const overlayScrollbarEnabled = scrollEnabled && !isMobileBreakpoint;
    return {
      width: "100%",
      height: "100%",
      overflowX: "hidden",
      overflowY: scrollEnabled ? "auto" : "hidden",
      overscrollBehaviorY: "contain",
      // The browser still anchors delayed image growth while following output.
      // Detached reading has one owner: reconcileReadingPosition.
      overflowAnchor: followOutput ? "auto" : "none",
      scrollbarWidth: overlayScrollbarEnabled ? "none" : undefined,
    };
  }, [followOutput, isMobileBreakpoint, scrollEnabled]);
  const viewportStyle = useMemo(
    (): CSSProperties => ({
      position: "relative",
      flex: 1,
      minWidth: 0,
      minHeight: 0,
    }),
    [],
  );
  const virtualRowsContainerStyle = useMemo(
    (): CSSProperties => ({
      height: virtualTotalSize,
      flexShrink: 0,
    }),
    [virtualTotalSize],
  );
  const renderVirtualRowStyle = useCallback(
    (start: number): CSSProperties => ({
      position: "absolute",
      top: start - VIRTUALIZER_SCROLL_MARGIN_PX,
      left: 0,
      display: "flex",
      flexDirection: "column",
      width: "100%",
    }),
    [],
  );
  const mountedHistoryRows = useMemo(() => {
    return segments.historyMounted.map((item, index) => (
      <div
        key={item.id}
        data-history-row-id={item.id}
        data-message-id={getStreamItemMessageId(item)}
        data-actual-prompt-row={item.kind === "user_message" ? "" : undefined}
        data-plugin-row={item.kind === "plugin" ? "true" : undefined}
        style={streamRowStyle}
      >
        <ActualRowContent
          bodyRef={observeActualRowBody}
          onFlowGeometryChange={onFlowGeometryChange}
          onPaintGeometryChange={onPaintGeometryChange}
          isPrompt={item.kind === "user_message"}
          pinned={pinnedRowId === item.id}
        >
          <StreamRowContent
            item={item}
            index={index}
            items={segments.historyMounted}
            render={renderHistoryMountedRow}
          />
        </ActualRowContent>
      </div>
    ));
  }, [
    observeActualRowBody,
    onFlowGeometryChange,
    onPaintGeometryChange,
    pinnedRowId,
    renderHistoryMountedRow,
    segments.historyMounted,
  ]);
  const liveHeadRows = useMemo(() => {
    return segments.liveHead.map((item, index) => (
      <div
        key={item.id}
        data-history-row-id={item.id}
        data-message-id={getStreamItemMessageId(item)}
        data-actual-prompt-row={item.kind === "user_message" ? "" : undefined}
        data-plugin-row={item.kind === "plugin" ? "true" : undefined}
        style={streamRowStyle}
      >
        <ActualRowContent
          bodyRef={observeActualRowBody}
          onFlowGeometryChange={onFlowGeometryChange}
          onPaintGeometryChange={onPaintGeometryChange}
          isPrompt={item.kind === "user_message"}
          pinned={pinnedRowId === item.id}
        >
          <StreamRowContent
            item={item}
            index={index}
            items={segments.liveHead}
            revision={liveHeadRowRevision}
            render={renderLiveHeadRow}
          />
        </ActualRowContent>
      </div>
    ));
  }, [
    observeActualRowBody,
    onFlowGeometryChange,
    onPaintGeometryChange,
    pinnedRowId,
    liveHeadRowRevision,
    renderLiveHeadRow,
    segments.liveHead,
  ]);
  const retainedPromptRow = renderRetainedPromptRow({
    item: retainedPrompt,
    pinnedRowId,
    onGeometryChange: onRetainedFlowGeometryChange,
    render: renderHistoryMountedRow,
  });
  const mountedRows = useMemo(
    () => [...mountedHistoryRows, ...liveHeadRows],
    [liveHeadRows, mountedHistoryRows],
  );
  const liveAuxiliary = useMemo(() => {
    return renderLiveAuxiliary();
  }, [renderLiveAuxiliary]);
  const historyStartSlot = useMemo(() => {
    const isLoadingOperation = isHistoryStartLoadingOperation(historyStartPaginationState);
    return (
      <div style={historyStartSlotStyle} data-testid="older-history-slot">
        {isLoadingOperation ? (
          <div data-testid="load-older-history-spinner">
            <ThemedLoadingSpinner size="small" uniProps={foregroundMutedColorMapping} />
          </div>
        ) : null}
      </div>
    );
  }, [historyStartPaginationState]);
  const shouldRenderEmpty =
    !boundary.hasMountedHistory &&
    !boundary.hasVirtualizedHistory &&
    !boundary.hasLiveHead &&
    !liveAuxiliary;

  return (
    <div style={viewportStyle} data-window-content>
      <div
        ref={handleScrollContainerRef}
        // Let clicks focus the feed for browser keyboard scrolling without adding a Tab stop.
        tabIndex={-1}
        data-testid="agent-chat-scroll"
        data-overlay-scrollbar={scrollEnabled && !isMobileBreakpoint ? "true" : undefined}
        id={`agent-chat-scroll-${shouldUseVirtualizer ? "web-dom-virtualized" : "web-dom-scroll"}`}
        style={scrollContainerStyle}
      >
        <div ref={handleContentRef} style={contentContainerStyle}>
          {historyStartSlot}
          <div data-stream-rows-host style={streamRowsHostStyle}>
            <div style={virtualRowsContainerStyle} />
            {[
              ...virtualRows.map((virtualRow) => {
                const item = segments.historyVirtualized[virtualRow.index];
                if (!item) return null;
                return (
                  <div
                    key={item.id}
                    data-index={virtualRow.index}
                    data-history-row-id={item.id}
                    data-message-id={getStreamItemMessageId(item)}
                    data-actual-prompt-row={item.kind === "user_message" ? "" : undefined}
                    data-plugin-row={item.kind === "plugin" ? "true" : undefined}
                    style={renderVirtualRowStyle(virtualRow.start)}
                  >
                    <ActualRowContent
                      bodyRef={observeActualRowBody}
                      onFlowGeometryChange={onFlowGeometryChange}
                      onPaintGeometryChange={onPaintGeometryChange}
                      isPrompt={item.kind === "user_message"}
                      pinned={pinnedRowId === item.id}
                    >
                      <StreamRowContent
                        item={item}
                        index={virtualRow.index}
                        items={segments.historyVirtualized}
                        render={renderHistoryVirtualizedRow}
                      />
                    </ActualRowContent>
                  </div>
                );
              }),
              ...mountedRows,
              retainedPromptRow,
            ]}
          </div>
          <div data-stream-auxiliary style={streamRowStyle}>
            {liveAuxiliary}
          </div>
          {shouldRenderEmpty ? listEmptyComponent : null}
        </div>
      </div>
      {scrollEnabled && !isMobileBreakpoint ? (
        <DomOverlayScrollbar
          scrollContainerRef={scrollContainerRef}
          onUserScrollUp={stopFollowingOutputFromUserIntent}
        />
      ) : null}
    </div>
  );
}

export function createWebStreamStrategy(input: CreateWebStreamStrategyInput): StreamStrategy {
  return createStreamStrategy({
    render: (renderInput) => (
      <WebStreamViewport
        key={renderInput.agentId}
        {...renderInput}
        isMobileBreakpoint={input.isMobileBreakpoint}
      />
    ),
    orderTailReverse: false,
    orderHeadReverse: false,
    assistantTurnTraversalStep: -1,
    edgeSlot: "footer",
    historyLiveBoundaryEdge: "last",
    liveHeadHistoryBoundaryEdge: "first",
    frameChildOrder: "content-then-footer",
    flatListInverted: false,
    overlayScrollbarInverted: false,
    maintainVisibleContentPosition: undefined,
    bottomAnchorTransportBehavior: {
      verificationDelayFrames: 0,
      verificationRetryMode: "rescroll",
    },
    disableParentScrollOnInlineDetailsExpansion: false,
    anchorBottomOnContentSizeChange: true,
    animateManualScrollToBottom: false,
    useVirtualizedList: false,
    isNearBottom: (inputMetrics) => {
      const distanceFromBottom = Math.max(
        0,
        inputMetrics.contentHeight - (inputMetrics.offsetY + inputMetrics.viewportHeight),
      );
      return distanceFromBottom <= inputMetrics.threshold;
    },
    getBottomOffset: (metrics) => Math.max(0, metrics.contentHeight - metrics.viewportHeight),
  });
}

/** Read actual source line boxes without estimating wrapping from message length. */
function measurePromptTextPrefix(bubble: HTMLElement) {
  const text = bubble.querySelector<HTMLElement>('[data-testid="user-message-text"]');
  // The renderer supplies an explicit line-height. This is the actual CSS line box,
  // not a character-count or wrapping estimate; the source text remains unbounded.
  const lineHeight = text ? Number.parseFloat(window.getComputedStyle(text).lineHeight) : 0;
  const textHeight = text?.clientHeight ?? 0;
  const prefixHeightOne = Number.isFinite(lineHeight) ? Math.min(textHeight, lineHeight) : 0;
  const prefixHeightTwo = Number.isFinite(lineHeight) ? Math.min(textHeight, lineHeight * 2) : 0;
  return { prefixHeightOne, prefixHeightTwo };
}
