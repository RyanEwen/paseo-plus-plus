import { useLayoutEffect } from "react";
import { NativeStickyLayoutContext } from "./native-sticky-layout-context";
import { useContext } from "react";
import { useAnimatedRef, useScrollOffset } from "react-native-reanimated";
import { useDockReservation } from "@/keyboard/shift/internal/dock-reservation";
import { ActualPromptRowsContext, ActualPinnedRowContext } from "./actual-prompt-rows";
import { ActualStickyHeader, NativeActualMotionBoundary } from "./actual-sticky-header";
import {
  NativeStickyViewportProvider,
  useNativeReadingRefresh,
  useNativeMeasurementContext,
} from "./native-sticky-viewport";
import {
  nativeBottomDistance,
  publishMeasuredNativeNearBottom,
  nativeOriginalTop,
  nativeChronologicalRows,
  createNativeMeasuredHeaderIndex,
  createNativeViewportLifetime,
  createNativeViewportMetrics,
  isCurrentNativeReading,
  resolveActualNativeReading,
  resolveNativeMeasurementOwner,
  resolveNativeStickyHeights,
  type ActualNativeRowGeometry,
  type NativeViewportLifetime,
  type NativeViewportAttachment,
  type NativeViewportRefEffects,
  type NativeViewportRefOwner,
} from "./native-actual-row-model";
import type { PromptJumpPlacement } from "./prompt-jump-placement";
import {
  type ReactElement,
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  FlatList,
  Platform,
  View,
  type FlatListProps,
  type LayoutChangeEvent,
  type ListRenderItemInfo,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ViewStyle,
} from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { withUnistyles } from "react-native-unistyles";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { StreamItem } from "@/types/stream";
import type { Theme } from "@/styles/theme";
import { createNativePromptJumpController } from "./native-prompt-jump";
import { useStableEvent } from "@/hooks/use-stable-event";
import { shouldAnimateNativeScrollToBottom } from "./native-scroll-animation";
import { useRevisedHistoryRows } from "./history-row-revision";
import {
  useBottomAnchorController,
  type PaintedNativeTailBinding,
  type PaintedNativeTailRow,
  type PaintedNativeTailEvidence,
  type BottomAnchorUserScroll,
} from "./bottom-anchor-controller";
import { useScrollKeyboardDismiss } from "./scroll-keyboard-dismiss/use-scroll-keyboard-dismiss";
import type {
  StreamRenderInput,
  StreamStrategy,
  StreamViewportHandle,
  ScrollToMessageOccurrence,
} from "./strategy";
import {
  createStreamStrategy,
  isNearBottomForStreamRenderStrategy,
  resolveBottomAnchorTransportBehavior,
} from "./strategy";
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
import { useStreamTopOverlayInset } from "./top-overlay";
import {
  createHistoryStartSettleScheduler,
  type HistoryStartSettleScheduler,
} from "./history-start-settle-scheduler";

const DEFAULT_MAINTAIN_VISIBLE_CONTENT_POSITION = Object.freeze({
  minIndexForVisible: 0,
  autoscrollToTopThreshold: 0,
});

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const historyStartSlotStyle: ViewStyle = {
  alignItems: "center",
  justifyContent: "center",
  minHeight: 32,
  flexGrow: 1,
  flexShrink: 0,
};
const leadingSlotStyle: ViewStyle = { flexGrow: 1 };
const HELD_READING_POSITION = Object.freeze({ minIndexForVisible: 1 });
const HISTORY_START_SETTLE_FRAMES = 2;
const NATIVE_STREAM_WINDOW_SIZE = 10;

const NativePaintedTailBindingContext = createContext<PaintedNativeTailBinding | null>(null);

interface NativeViewportHandlers {
  refEffects: NativeViewportRefEffects<FlatList<StreamItem>>;
  onLayout(origin: NativeViewportLifetime, event: LayoutChangeEvent): void;
  onContentSizeChange(origin: NativeViewportLifetime, width: number, height: number): void;
  onScroll(origin: NativeViewportLifetime, event: NativeSyntheticEvent<NativeScrollEvent>): void;
  onScrollBeginDrag(
    origin: NativeViewportLifetime,
    event: NativeSyntheticEvent<NativeScrollEvent>,
  ): void;
  onScrollEndDrag(
    origin: NativeViewportLifetime,
    event: NativeSyntheticEvent<NativeScrollEvent>,
  ): void;
  onMomentumScrollBegin(origin: NativeViewportLifetime): void;
  onMomentumScrollEnd(
    origin: NativeViewportLifetime,
    event: NativeSyntheticEvent<NativeScrollEvent>,
  ): void;
}

interface NativeViewportListProps extends Omit<
  FlatListProps<StreamItem>,
  keyof NativeViewportHandlers
> {
  viewportHandlers: NativeViewportHandlers;
}

interface NativeViewportGesture {
  origin: NativeViewportLifetime;
  scroll: BottomAnchorUserScroll;
}

/** This component always owns the same unkeyed FlatList child. A replacement
 * component creates new callbacks with a new origin; delayed callbacks retain
 * the old one. There is no additional native View or forced remount.
 */
function NativeViewportList({ viewportHandlers, ...props }: NativeViewportListProps) {
  const originRef = useRef<NativeViewportRefOwner<FlatList<StreamItem>> | null>(null);
  if (!originRef.current) originRef.current = createNativeViewportLifetime<FlatList<StreamItem>>();
  const origin = originRef.current;
  useLayoutEffect(
    () => origin.activate(viewportHandlers.refEffects),
    [origin, viewportHandlers.refEffects],
  );
  const attach = useCallback(
    (viewport: FlatList<StreamItem> | null) =>
      origin.bindRef(viewport, viewportHandlers.refEffects),
    [origin, viewportHandlers],
  );
  const events = useMemo<
    Pick<
      FlatListProps<StreamItem>,
      | "onLayout"
      | "onContentSizeChange"
      | "onScroll"
      | "onScrollBeginDrag"
      | "onScrollEndDrag"
      | "onMomentumScrollBegin"
      | "onMomentumScrollEnd"
    >
  >(
    () => ({
      onLayout: (event) => viewportHandlers.onLayout(origin, event),
      onContentSizeChange: (width, height) =>
        viewportHandlers.onContentSizeChange(origin, width, height),
      onScroll: (event) => viewportHandlers.onScroll(origin, event),
      onScrollBeginDrag: (event) => viewportHandlers.onScrollBeginDrag(origin, event),
      onScrollEndDrag: (event) => viewportHandlers.onScrollEndDrag(origin, event),
      onMomentumScrollBegin: () => viewportHandlers.onMomentumScrollBegin(origin),
      onMomentumScrollEnd: (event) => viewportHandlers.onMomentumScrollEnd(origin, event),
    }),
    [origin, viewportHandlers],
  );
  return <FlatList {...props} {...events} ref={attach} />;
}

interface PaintedNativeRowMeasurement {
  binding: PaintedNativeTailBinding;
  item: StreamItem;
  index: number;
  height: number;
}

interface ActualCellCallbacks {
  record(id: string, geometry: ActualNativeRowGeometry): void;
  mount(id: string, mounted: boolean): void;
  recordPainted(measurement: PaintedNativeRowMeasurement): void;
}

/** Cell type is stable across current-turn completion and history prepends. RN's
 * sticky wrapper forwards this onLayout once; children never own absolute L. */
function createActualCellRenderer({ record, mount, recordPainted }: ActualCellCallbacks) {
  return function ActualCell({
    item,
    index,
    onLayout,
    children,
    style,
    onFocusCapture,
  }: import("react-native").CellRendererProps<StreamItem>) {
    const sticky = useContext(NativeStickyLayoutContext);
    const actualRowsEnabled = useContext(ActualPromptRowsContext) !== null;
    const paintedBinding = useContext(NativePaintedTailBindingContext);
    const latestLayout = useRef<LayoutChangeEvent | null>(null);
    const layoutPosition = useRef<{ id: string; index: number } | null>(null);
    const paintedReport = useRef<((event: LayoutChangeEvent) => void) | null>(null);
    useLayoutEffect(() => {
      mount(item.id, true);
      return () => mount(item.id, false);
    }, [item.id]);
    useLayoutEffect(() => {
      const report = (event: LayoutChangeEvent) => {
        if (!paintedBinding) return;
        recordPainted({
          binding: paintedBinding,
          item,
          index,
          height: event.nativeEvent.layout.height,
        });
      };
      paintedReport.current = report;
      // A committed update may retain this same physical cell without another
      // native layout event. Rebind only its held frame at the same ID/index.
      const samePosition =
        layoutPosition.current?.id === item.id && layoutPosition.current.index === index;
      if (samePosition && latestLayout.current) report(latestLayout.current);
      return () => {
        paintedReport.current = null;
      };
    }, [paintedBinding, item, index]);
    const recordCurrent = useCallback(() => {
      const layout = latestLayout.current?.nativeEvent.layout;
      if (!layout) return;
      const heights = resolveNativeStickyHeights({
        layoutHeight: layout.height,
        body: sticky?.readBody() ?? null,
      });
      record(item.id, {
        index,
        y: layout.y,
        height: layout.height,
        pinnedHeight: heights?.pinnedHeight ?? layout.height,
        fullRowReady:
          sticky?.position?.handoff === "full-row"
            ? heights !== null && sticky.readBody() !== null
            : undefined,
      });
    }, [item.id, index, sticky]);
    const measure = useCallback(
      (event: LayoutChangeEvent) => {
        event.persist();
        latestLayout.current = event;
        layoutPosition.current = { id: item.id, index };
        recordCurrent();
        paintedReport.current?.(event);
        onLayout?.(event);
      },
      [recordCurrent, onLayout, item.id, index],
    );
    useLayoutEffect(() => {
      latestLayout.current = null;
      const stopLayout = sticky?.subscribe(measure);
      // Visual-only disclosure must update collision without reporting a fake
      // flow resize to VirtualizedList or maintainVisibleContentPosition.
      const stopBody = sticky?.subscribeBody(recordCurrent);
      return () => {
        stopLayout?.();
        stopBody?.();
      };
    }, [sticky, measure, recordCurrent]);
    // RN forwards this capture callback, but its public ViewProps omits the field.
    const focusProps = useMemo(() => ({ onFocusCapture }), [onFocusCapture]);
    return (
      <View
        {...focusProps}
        onLayout={sticky ? undefined : measure}
        collapsable={false}
        pointerEvents={sticky && actualRowsEnabled ? "box-none" : undefined}
        style={[style, { overflow: "visible" }]}
      >
        {children}
      </View>
    );
  };
}

function keyExtractor(item: { id: string }): string {
  return item.id;
}

function NativeStreamViewport(props: StreamRenderInput & { strategy: StreamStrategy }) {
  return (
    <NativeActualMotionBoundary allowStandalone={props.nativeViewportPlacement === "standalone"}>
      <NativeActualViewport {...props} />
    </NativeActualMotionBoundary>
  );
}
function NativeActualViewport(props: StreamRenderInput & { strategy: StreamStrategy }) {
  const {
    agentId,
    segments,
    historyRowRevision,
    liveHeadRowRevision,
    renderers,
    listEmptyComponent,
    viewportRef,
    routeBottomAnchorRequest,
    isAuthoritativeHistoryReady,
    onNearBottomChange,
    onNearHistoryStart,
    isLoadingOlderHistory,
    hasOlderHistory,
    olderHistoryProgressKey,
    scrollEnabled,
    listStyle,
    baseListContentContainerStyle,
    strategy,
  } = props;
  const { renderHistoryMountedRow, renderLiveHeadRow, renderLiveAuxiliary } = renderers;
  const nativeOwnerAlive = useRef(true);
  useLayoutEffect(() => {
    nativeOwnerAlive.current = true;
    return () => {
      nativeOwnerAlive.current = false;
    };
  }, []);
  const reducedMotion = useReducedMotion();
  const [viewportIdentity, setViewportIdentity] = useState<FlatList<StreamItem> | null>(null);
  const currentViewportLifetime = useRef<NativeViewportLifetime | null>(null);
  const lastAttachedViewport = useRef<NativeViewportAttachment<FlatList<StreamItem>> | null>(null);
  const flatListRef = useAnimatedRef<FlatList<StreamItem>>();
  const resetViewportMeasurements = useStableEvent(() => {
    streamViewportMetricsRef.current = createNativeViewportMetrics();
    scrollOffsetYRef.current = 0;
    measuredViewportIdentity.current = null;
    measuredContentIdentity.current = null;
    programmaticScrollEventBudgetRef.current = 0;
  });
  const retireViewportGesture = useStableEvent((origin: NativeViewportLifetime) => {
    const gesture = viewportGesture.current;
    if (!gesture || gesture.origin !== origin) return;
    viewportGesture.current = null;
    clearPendingUserScrollEnd();
    isUserScrollActiveRef.current = false;
    gesture.scroll.retire();
  });
  const getHeldViewport = useStableEvent(() => flatListRef.current);
  const getGestureOrigin = useStableEvent(() => viewportGesture.current?.origin ?? null);
  const setAnimatedViewport = useStableEvent((viewport: FlatList<StreamItem> | null) => {
    // An animated ref returns a shadow node, never React's cleanup function.
    flatListRef(viewport);
  });
  const clearPaintedRows = useStableEvent(() => {
    paintedRows.current.clear();
  });
  const invalidatePendingViewportReads = useStableEvent(() => {
    readingRequest.current += 1;
  });
  const viewportRefEffects = useMemo<NativeViewportRefEffects<FlatList<StreamItem>>>(
    () => ({
      lastAttachment: lastAttachedViewport,
      currentLifetime: currentViewportLifetime,
      getHeldViewport,
      getGestureOrigin,
      setAnimatedRef: setAnimatedViewport,
      setViewportIdentity,
      invalidatePendingReads: invalidatePendingViewportReads,
      resetMeasurements: resetViewportMeasurements,
      clearPaintedRows,
      retireGesture: retireViewportGesture,
    }),
    [
      getHeldViewport,
      getGestureOrigin,
      setAnimatedViewport,
      resetViewportMeasurements,
      clearPaintedRows,
      retireViewportGesture,
      invalidatePendingViewportReads,
    ],
  );
  const isCurrentViewport = useStableEvent(
    (origin: NativeViewportLifetime) =>
      nativeOwnerAlive.current &&
      origin.isCurrent(currentViewportLifetime.current, flatListRef.current),
  );
  const getCurrentViewport = useStableEvent(() => {
    const origin = currentViewportLifetime.current;
    return origin && isCurrentViewport(origin) ? flatListRef.current : null;
  });
  const getViewportMeasurements = useStableEvent(() => {
    const origin = currentViewportLifetime.current;
    if (!nativeOwnerAlive.current || !origin) return createNativeViewportMetrics();
    return origin.readMeasurements({
      current: origin,
      held: flatListRef.current,
      measurements: streamViewportMetricsRef.current,
    });
  });
  const nativeY = useScrollOffset(flatListRef);
  const nativeStickyViewport = useMemo(() => ({ y: nativeY }), [nativeY]);
  const reservationSnapshot = useDockReservation();
  const reservation = reservationSnapshot.extent;
  const topOverlayInset = useStreamTopOverlayInset();
  const measurementContext = useNativeMeasurementContext();
  const getMeasurementOwner = useStableEvent(() => {
    const viewport = getCurrentViewport()?.getNativeScrollRef();
    if (!viewport || !("measureInWindow" in viewport)) return null;
    return resolveNativeMeasurementOwner<
      Pick<import("react-native").NativeMethods, "measureInWindow">
    >(measurementContext.mode, viewport, measurementContext.stationaryViewportRef?.current ?? null);
  });
  const actualRows = useContext(ActualPromptRowsContext);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const mountedRows = useRef(new Set<string>());
  const actualGeometry = useRef(new Map<string, ActualNativeRowGeometry>());
  const paintedRows = useRef(new Map<string, PaintedNativeTailRow>());
  const measuredViewportIdentity = useRef<object | null>(null);
  const measuredContentIdentity = useRef<object | null>(null);
  const [geometryRevision, setGeometryRevision] = useState(0);
  const expandActual = actualRows?.expand;
  const registerActualViewport = actualRows?.registerViewport;
  const reportActualHeight = actualRows?.reportViewportHeight;
  const navigatingPromptRef = useRef(false);
  const promptSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const streamViewportMetricsRef = useRef(createNativeViewportMetrics());
  const scrollOffsetYRef = useRef(0);
  const isUserScrollActiveRef = useRef(false);
  const viewportGesture = useRef<NativeViewportGesture | null>(null);
  const scrollKeyboardDismiss = useScrollKeyboardDismiss(strategy.getFlatListInverted());

  const userScrollEndFrameIdRef = useRef<number | null>(null);
  const programmaticScrollEventBudgetRef = useRef(0);
  const isNativeViewportSettlingRef = useRef(false);
  const nativeViewportSettlingFrameIdRef = useRef<number | null>(null);
  const historyStartReadyRef = useRef(false);
  const [historyStartPaginationState, setHistoryStartPaginationState] = useState(
    createHistoryStartPaginationState,
  );
  const historyStartPaginationStateRef = useRef(historyStartPaginationState);
  const historyStartSettleSchedulerRef = useRef<HistoryStartSettleScheduler | null>(null);

  const historyItems = useMemo(() => nativeChronologicalRows(segments), [segments]);
  const historyRows = useRevisedHistoryRows(historyItems, historyRowRevision);
  const promptScope = actualRows?.scope;
  const readingBinding = useMemo(
    () => ({
      agentId,
      scope: promptScope,
      headers: createNativeMeasuredHeaderIndex({
        items: historyItems,
        geometry: actualGeometry.current,
      }),
    }),
    [agentId, promptScope, historyItems],
  );
  const measuredHeaders = readingBinding.headers;
  const paintedBinding = useMemo<PaintedNativeTailBinding | null>(() => {
    if (
      !viewportIdentity ||
      !routeBottomAnchorRequest ||
      routeBottomAnchorRequest.agentId !== agentId
    )
      return null;
    return {
      agentId,
      requestKey: routeBottomAnchorRequest.requestKey,
      containerKey: "native-virtualized",
      items: historyRows,
      scopeIdentity: readingBinding,
      viewportIdentity,
    };
  }, [agentId, routeBottomAnchorRequest, viewportIdentity, historyRows, readingBinding]);
  const committedPaintedBinding = useRef<PaintedNativeTailBinding | null>(null);
  const committedHeaders = useRef(measuredHeaders);
  useLayoutEffect(() => {
    committedHeaders.current = measuredHeaders;
  }, [measuredHeaders]);
  const getHistoryStartPaginationInput = useStableEvent((): HistoryStartPaginationInput => {
    const metrics = getViewportMeasurements();
    const hasMeasuredViewport =
      metrics.viewportMeasuredForKey === metrics.containerKey &&
      metrics.contentMeasuredForKey === metrics.containerKey;
    return {
      distanceFromHistoryStart: metrics.offsetY,
      contentHeight: metrics.contentHeight,
      viewportHeight: metrics.viewportHeight,
      hasOlderHistory,
      isLoadingOlderHistory,
      isReady: historyStartReadyRef.current && hasMeasuredViewport,
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
      if (transition.shouldLoad) {
        const requestedProgressKey = olderHistoryProgressKey;
        if (requestedProgressKey === null) {
          return;
        }
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
      }
    },
  );
  const evaluateHistoryStart = useStableEvent(() => {
    const transition = evaluateHistoryStartPagination(
      historyStartPaginationStateRef.current,
      getHistoryStartPaginationInput(),
    );
    applyHistoryStartPaginationTransition(transition);
  });
  const scheduleHistoryStartSettle = useStableEvent(() => {
    let scheduler = historyStartSettleSchedulerRef.current;
    if (!scheduler) {
      scheduler = createHistoryStartSettleScheduler({
        settleFrames: HISTORY_START_SETTLE_FRAMES,
        requestFrame: requestAnimationFrame,
        cancelFrame: cancelAnimationFrame,
        isSettling: () => historyStartPaginationStateRef.current.status === "settling",
        isLoading: () => getHistoryStartPaginationInput().isLoadingOlderHistory,
        onSettle: () => {
          const transition = settleHistoryStartPagination(
            historyStartPaginationStateRef.current,
            getHistoryStartPaginationInput(),
          );
          applyHistoryStartPaginationTransition(transition);
        },
      });
      historyStartSettleSchedulerRef.current = scheduler;
    }
    scheduler.schedule();
  });

  const clearNativeViewportSettling = useCallback(() => {
    if (nativeViewportSettlingFrameIdRef.current !== null) {
      cancelAnimationFrame(nativeViewportSettlingFrameIdRef.current);
      nativeViewportSettlingFrameIdRef.current = null;
    }
  }, []);

  const clearPendingUserScrollEnd = useCallback(() => {
    if (userScrollEndFrameIdRef.current !== null) {
      cancelAnimationFrame(userScrollEndFrameIdRef.current);
      userScrollEndFrameIdRef.current = null;
    }
  }, []);

  const markNativeViewportSettling = useCallback(() => {
    clearNativeViewportSettling();
    isNativeViewportSettlingRef.current = true;
    let remainingFrames = 4;
    const tick = () => {
      if (remainingFrames <= 0) {
        nativeViewportSettlingFrameIdRef.current = null;
        isNativeViewportSettlingRef.current = false;
        return;
      }
      remainingFrames -= 1;
      nativeViewportSettlingFrameIdRef.current = requestAnimationFrame(tick);
    };
    nativeViewportSettlingFrameIdRef.current = requestAnimationFrame(tick);
  }, [clearNativeViewportSettling]);

  const getBottomAnchorTransportBehavior = useCallback(
    () =>
      resolveBottomAnchorTransportBehavior({
        strategy,
        isViewportSettling: isNativeViewportSettlingRef.current,
      }),
    [strategy],
  );

  const scrollToBottom = useStableEvent((animated: boolean) => {
    const list = getCurrentViewport();
    if (!list) return;
    programmaticScrollEventBudgetRef.current = 3;
    const offset = Math.max(
      0,
      streamViewportMetricsRef.current.contentHeight -
        streamViewportMetricsRef.current.viewportHeight,
    );
    list.scrollToOffset({
      offset,
      animated:
        animated &&
        shouldAnimateNativeScrollToBottom({
          offsetY: Math.abs(offset - scrollOffsetYRef.current),
          viewportHeight: streamViewportMetricsRef.current.viewportHeight,
          windowSize: NATIVE_STREAM_WINDOW_SIZE,
        }),
    });
    // A target is not a native observation. Only handleScroll may publish the
    // actual offset/near-bottom result, including when no movement was possible.
  });

  /** Current rows and both measurements must belong to this committed native view. */
  const getPaintedNativeTailEvidence = useStableEvent((): PaintedNativeTailEvidence | null => {
    if (!paintedBinding || committedPaintedBinding.current !== paintedBinding) return null;
    const origin = currentViewportLifetime.current;
    if (!origin || !isCurrentViewport(origin)) return null;
    const viewport = flatListRef.current;
    const currentViewport =
      viewport === paintedBinding.viewportIdentity &&
      measuredViewportIdentity.current === viewport &&
      measuredContentIdentity.current === viewport;
    if (!nativeOwnerAlive.current || !currentViewport) return null;
    for (const id of mountedRows.current) {
      const row = paintedRows.current.get(id);
      if (
        row?.binding === paintedBinding &&
        row.height > 0 &&
        paintedBinding.items[row.index]?.id === id
      ) {
        return { current: paintedBinding, row };
      }
    }
    return null;
  });

  const bottomAnchorController = useBottomAnchorController({
    agentId,
    routeRequest: routeBottomAnchorRequest,
    isAuthoritativeHistoryReady,
    renderStrategy: "chronological-native-stream",
    getTransportBehavior: getBottomAnchorTransportBehavior,
    getMeasurementState: getViewportMeasurements,
    getPaintedNativeTailEvidence,
    isNearBottom: () => {
      if (!getCurrentViewport()) return false;
      const metrics = streamViewportMetricsRef.current;
      return isNearBottomForStreamRenderStrategy({
        strategy,
        offsetY: metrics.offsetY,
        threshold: 32,
        contentHeight: metrics.contentHeight,
        viewportHeight: metrics.viewportHeight,
      });
    },
    scrollToBottom,
  });
  useLayoutEffect(() => {
    committedPaintedBinding.current = paintedBinding;
    bottomAnchorController.notifyPaintedNativeTailMaybeChanged();
  }, [paintedBinding, bottomAnchorController]);
  // Only RN preserves the held reading cell on prepends. The existing bottom
  // controller owns follow corrections; disable competing RN auto-follow.
  const maintainVisibleContentPosition =
    bottomAnchorController.mode === "sticky-bottom" ? undefined : HELD_READING_POSITION;
  const leadingReservation = reservation + topOverlayInset;
  const lastReservation = useRef(leadingReservation);
  useLayoutEffect(() => {
    if (lastReservation.current === leadingReservation) return;
    lastReservation.current = leadingReservation;
    bottomAnchorController.prepareForStickyViewportChange();
  }, [leadingReservation, bottomAnchorController]);

  const listContentContainerStyle = useMemo(
    // This branch is chronological: visual-top clearance belongs to paddingTop.
    () => [baseListContentContainerStyle, { paddingTop: leadingReservation }],
    [baseListContentContainerStyle, leadingReservation],
  );
  const listInsetProps = {
    automaticallyAdjustContentInsets: false,
    automaticallyAdjustsScrollIndicatorInsets: false,
    contentInsetAdjustmentBehavior: "never" as const,
  };
  useEffect(
    () =>
      registerActualViewport?.(() => {
        bottomAnchorController.prepareForStickyContentChange();
      }),
    [registerActualViewport, bottomAnchorController],
  );

  useEffect(() => {
    resetViewportMeasurements();
    const departingGesture = viewportGesture.current;
    if (departingGesture) retireViewportGesture(departingGesture.origin);
    isUserScrollActiveRef.current = false;
    clearPendingUserScrollEnd();
    clearNativeViewportSettling();
    isNativeViewportSettlingRef.current = false;
    historyStartReadyRef.current = false;
    const initialHistoryStartState = createHistoryStartPaginationState();
    historyStartPaginationStateRef.current = initialHistoryStartState;
    setHistoryStartPaginationState(initialHistoryStartState);
    const frame = requestAnimationFrame(() => {
      historyStartReadyRef.current = true;
      evaluateHistoryStart();
    });
    return () => {
      cancelAnimationFrame(frame);
      clearPendingUserScrollEnd();
      historyStartSettleSchedulerRef.current?.cancel();
      historyStartSettleSchedulerRef.current = null;
    };
  }, [
    agentId,
    clearNativeViewportSettling,
    clearPendingUserScrollEnd,
    evaluateHistoryStart,
    resetViewportMeasurements,
    retireViewportGesture,
  ]);

  useEffect(() => () => clearNativeViewportSettling(), [clearNativeViewportSettling]);

  useEffect(() => {
    bottomAnchorController.prepareForStickyContentChange();
  }, [bottomAnchorController, historyRows, segments.liveHead]);

  const findHistoryPromptIndex = useStableEvent((id: string) =>
    historyItems.findIndex((item) => item.id === id),
  );
  const getLeadingExtent = useStableEvent(() => {
    const first = historyItems[0];
    return first ? (actualGeometry.current.get(first.id)?.y ?? null) : null;
  });
  const reportPromptFailure = useStableEvent(() => props.onMessageNavigationError?.());
  const promptJumpController = useMemo(
    () =>
      createNativePromptJumpController({
        direction: "chronological",
        viewport: {
          findHistoryIndex: findHistoryPromptIndex,
          findLiveOffset: () => undefined,
          getLiveHeaderHeight: getLeadingExtent,
          measureTarget: (id, callback) => {
            const row = actualGeometry.current.get(id);
            const owner = getMeasurementOwner();
            const viewport = owner?.viewport;
            const clip = owner?.clip;
            if (
              !row ||
              !mountedRows.current.has(id) ||
              row.index !== findHistoryPromptIndex(id) ||
              !viewport ||
              !("measureInWindow" in viewport) ||
              !clip
            ) {
              callback(null);
              return;
            }
            clip.measureInWindow((_clipX, clipY) =>
              viewport.measureInWindow((_x, listY) => {
                const metrics = streamViewportMetricsRef.current;
                if (
                  !mountedRows.current.has(id) ||
                  actualGeometry.current.get(id) !== row ||
                  getMeasurementOwner()?.viewport !== viewport ||
                  getMeasurementOwner()?.clip !== clip ||
                  row.index !== findHistoryPromptIndex(id)
                ) {
                  callback(null);
                  return;
                }
                callback({
                  top: nativeOriginalTop(row.y, metrics.offsetY, listY, clipY + topOverlayInset),
                  offset: metrics.offsetY,
                  maxOffset: Math.max(0, metrics.contentHeight - metrics.viewportHeight),
                });
              }),
            );
          },
          scrollToIndex: (index) =>
            getCurrentViewport()?.scrollToIndex({
              index,
              animated: !reducedMotion,
              viewPosition: 0,
            }),
          scrollToOffset: (offset, animated) =>
            getCurrentViewport()?.scrollToOffset({ offset, animated: animated && !reducedMotion }),
        },
        scheduleRetry: (callback) => {
          const timer = setTimeout(callback, 100);
          return () => clearTimeout(timer);
        },
        now: () => performance.now(),
        onFailure: reportPromptFailure,
      }),
    [
      findHistoryPromptIndex,
      reportPromptFailure,
      reducedMotion,
      getLeadingExtent,
      getMeasurementOwner,
      getCurrentViewport,
      topOverlayInset,
    ],
  );
  useEffect(() => () => promptJumpController.cancel(), [promptJumpController]);
  const readingRequest = useRef(0);
  const reportReadingPosition = useStableEvent(() => {
    if (!nativeOwnerAlive.current) return;
    const owner = getMeasurementOwner();
    if (!owner) return;
    const { viewport, clip } = owner;
    const request = ++readingRequest.current;
    clip.measureInWindow((_clipX, clipY) =>
      viewport.measureInWindow((_x, listY) => {
        if (
          !nativeOwnerAlive.current ||
          !isCurrentNativeReading({
            request,
            latestRequest: readingRequest.current,
            headers: measuredHeaders,
            currentHeaders: committedHeaders.current,
          }) ||
          getMeasurementOwner()?.viewport !== viewport ||
          getMeasurementOwner()?.clip !== clip
        )
          return;
        const m = streamViewportMetricsRef.current;
        const clippedLeading = Math.max(0, clipY + topOverlayInset - listY);
        reportActualHeight?.(
          Math.max(0, Math.min(m.viewportHeight - reservation, m.viewportHeight - clippedLeading)),
        );
        const { pinnedId: readingPinnedId, ...position } = resolveActualNativeReading({
          items: historyItems,
          geometry: actualGeometry.current,
          mounted: mountedRows.current,
          headers: measuredHeaders,
          offset: m.offsetY,
          viewportHeight: m.viewportHeight,
          clippedLeading,
          stickyEnabled: actualRows !== null,
          handoff: Platform.OS === "android" ? "full-row" : undefined,
        });
        setPinnedId(readingPinnedId);
        props.onReadingPositionChange?.({
          ...position,
          viewportWidth: m.viewportWidth,
          userHandoffs: [],
          navigating: navigatingPromptRef.current,
          following: bottomAnchorController.mode === "sticky-bottom",
          manual: isUserScrollActiveRef.current,
        });
      }),
    );
  });
  const invalidateReading = useStableEvent(() => {
    readingRequest.current += 1;
  });
  useNativeReadingRefresh(
    reservationSnapshot,
    reportReadingPosition,
    invalidateReading,
    measurementContext,
  );
  useEffect(() => {
    reportReadingPosition();
    return invalidateReading;
  }, [topOverlayInset, reportReadingPosition, invalidateReading]);
  const finishPromptAnimation = useStableEvent(() => {
    if (promptSettleTimerRef.current !== null) clearTimeout(promptSettleTimerRef.current);
    promptSettleTimerRef.current = null;
    navigatingPromptRef.current = false;
    reportReadingPosition();
  });
  const schedulePromptSettle = useStableEvent((delay: number) => {
    if (promptSettleTimerRef.current !== null) clearTimeout(promptSettleTimerRef.current);
    promptSettleTimerRef.current = setTimeout(() => {
      if (promptJumpController.isActive()) schedulePromptSettle(120);
      else finishPromptAnimation();
    }, delay);
  });
  const cancelPromptJump = useStableEvent(() => {
    promptJumpController.cancel();
    finishPromptAnimation();
  });
  const handleViewableItemsChanged = useStableEvent(() => {
    reportReadingPosition();
  });
  const viewabilityConfig = useMemo(() => ({ itemVisiblePercentThreshold: 0 }), []);

  /** Detach once for a new intent; controller retries preserve the same target and budget. */
  const scrollToPrompt = useStableEvent(
    (
      messageId: string,
      _occurrence?: ScrollToMessageOccurrence,
      placement?: PromptJumpPlacement,
    ) => {
      bottomAnchorController.detachByUser();
      navigatingPromptRef.current = true;
      promptJumpController.start(messageId, placement);
      schedulePromptSettle(450);
    },
  );

  useEffect(() => {
    cancelPromptJump();
    actualGeometry.current.clear();
    committedHeaders.current.clear();
    setPinnedId(null);
    return cancelPromptJump;
  }, [agentId, cancelPromptJump]);

  useEffect(() => {
    cancelPromptJump();
  }, [actualRows?.scope, cancelPromptJump]);

  useEffect(() => {
    const handle: StreamViewportHandle = {
      scrollToBottom: (reason = "jump-to-bottom") => {
        cancelPromptJump();
        bottomAnchorController.requestLocalAnchor({
          agentId,
          reason,
        });
      },
      expandMessageForFind: (id, signal) => {
        if (!signal.aborted) expandActual?.(id);
      },
      scrollToMessage: scrollToPrompt,
      cancelMessageScroll: cancelPromptJump,
      prepareForViewportChange: () => {
        bottomAnchorController.prepareForStickyViewportChange();
        markNativeViewportSettling();
      },
    };
    viewportRef.current = handle;
    return () => {
      if (viewportRef.current === handle) {
        viewportRef.current = null;
      }
    };
  }, [
    agentId,
    expandActual,
    bottomAnchorController,
    cancelPromptJump,
    markNativeViewportSettling,
    scrollToPrompt,
    viewportRef,
  ]);

  const isScrollEventNearBottom = useStableEvent(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      return isNearBottomForStreamRenderStrategy({
        strategy,
        offsetY: contentOffset.y,
        threshold: 32,
        contentHeight: contentSize.height,
        viewportHeight: layoutMeasurement.height,
      });
    },
  );

  const handleScroll = useStableEvent(
    (origin: NativeViewportLifetime, event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!isCurrentViewport(origin)) return;
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      const previousOffsetY = scrollOffsetYRef.current;
      scrollOffsetYRef.current = contentOffset.y;
      measuredViewportIdentity.current = flatListRef.current;
      measuredContentIdentity.current = flatListRef.current;
      scrollKeyboardDismiss.onScroll(event);

      streamViewportMetricsRef.current = {
        contentHeight: Math.max(0, contentSize.height),
        viewportWidth: Math.max(0, layoutMeasurement.width),
        viewportHeight: Math.max(0, layoutMeasurement.height),
        containerKey: "native-virtualized",
        offsetY: contentOffset.y,
        viewportMeasuredForKey: "native-virtualized",
        contentMeasuredForKey: "native-virtualized",
      };

      reportReadingPosition();
      if (navigatingPromptRef.current) schedulePromptSettle(120);
      const nearBottom = isScrollEventNearBottom(event);
      onNearBottomChange(nearBottom);

      evaluateHistoryStart();

      if (
        !isUserScrollActiveRef.current &&
        programmaticScrollEventBudgetRef.current > 0 &&
        nearBottom
      ) {
        programmaticScrollEventBudgetRef.current -= 1;
        // A late real observation can finish a provisional painted landing even
        // after its bounded verification frames expired; it cannot issue debt loops.
        bottomAnchorController.notifyPaintedNativeTailMaybeChanged();
      } else {
        programmaticScrollEventBudgetRef.current = 0;
        bottomAnchorController.handleScrollNearBottomChange({
          nextIsNearBottom: nearBottom,
          scrollDelta: contentOffset.y - previousOffsetY,
        });
      }
    },
  );

  const handleScrollBeginDrag = useStableEvent(
    (origin: NativeViewportLifetime, event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!isCurrentViewport(origin)) return;
      cancelPromptJump();
      clearPendingUserScrollEnd();
      const scroll = bottomAnchorController.beginUserScroll();
      if (!scroll) return;
      viewportGesture.current = { origin, scroll };
      isUserScrollActiveRef.current = true;
      reportReadingPosition();
      scrollKeyboardDismiss.onScrollBeginDrag(event);
      const rearmed = rearmHistoryStartPagination(historyStartPaginationStateRef.current);
      if (rearmed !== historyStartPaginationStateRef.current) {
        historyStartPaginationStateRef.current = rearmed;
        setHistoryStartPaginationState(rearmed);
        evaluateHistoryStart();
      }
    },
  );

  // Defer drag end so momentum can take ownership, but capture the terminal
  // gesture position now because layout may move the viewport in the meantime.
  const handleScrollEndDrag = useStableEvent(
    (origin: NativeViewportLifetime, event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!isCurrentViewport(origin)) return;
      const gesture = viewportGesture.current;
      if (!gesture || gesture.origin !== origin) return;
      const isNearBottom = isScrollEventNearBottom(event);
      scrollKeyboardDismiss.onScrollEndDrag(event);

      clearPendingUserScrollEnd();
      userScrollEndFrameIdRef.current = requestAnimationFrame(() => {
        if (!isCurrentViewport(origin) || viewportGesture.current !== gesture) return;
        userScrollEndFrameIdRef.current = null;
        viewportGesture.current = null;
        isUserScrollActiveRef.current = false;
        gesture.scroll.finish({ isNearBottom });
      });
    },
  );

  const handleMomentumScrollBegin = useStableEvent((origin: NativeViewportLifetime) => {
    if (!isCurrentViewport(origin) || viewportGesture.current?.origin !== origin) return;
    clearPendingUserScrollEnd();
  });

  const handleMomentumScrollEnd = useStableEvent(
    (origin: NativeViewportLifetime, event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!isCurrentViewport(origin)) return;
      const gesture = viewportGesture.current;
      if (!gesture || gesture.origin !== origin) return;
      // Android can emit momentum-end after a programmatic anchor correction.
      // Only momentum that still owns the user gesture may settle scroll intent.
      if (!isUserScrollActiveRef.current) {
        return;
      }
      const isNearBottom = isScrollEventNearBottom(event);
      clearPendingUserScrollEnd();
      viewportGesture.current = null;
      isUserScrollActiveRef.current = false;
      gesture.scroll.finish({ isNearBottom });
    },
  );

  const publishMeasuredNearBottom = useStableEvent(() => {
    publishMeasuredNativeNearBottom({
      metrics: streamViewportMetricsRef.current,
      threshold: 32,
      publish: onNearBottomChange,
    });
  });

  const handleListLayout = useStableEvent(
    (origin: NativeViewportLifetime, event: LayoutChangeEvent) => {
      if (!isCurrentViewport(origin)) return;
      measuredViewportIdentity.current = flatListRef.current;
      const previousViewportWidth = streamViewportMetricsRef.current.viewportWidth;
      const previousViewportHeight = streamViewportMetricsRef.current.viewportHeight;
      const viewportWidth = Math.max(0, event.nativeEvent.layout.width);
      const viewportHeight = Math.max(0, event.nativeEvent.layout.height);
      const viewportChanged =
        (previousViewportWidth > 0 && previousViewportWidth !== viewportWidth) ||
        (previousViewportHeight > 0 && previousViewportHeight !== viewportHeight);
      streamViewportMetricsRef.current = {
        ...streamViewportMetricsRef.current,
        containerKey: "native-virtualized",
        viewportWidth,
        viewportHeight,
        viewportMeasuredForKey: "native-virtualized",
      };
      // Initial layout can reveal an off-bottom viewport before any native scroll.
      publishMeasuredNearBottom();
      if (viewportChanged) {
        markNativeViewportSettling();
      }
      bottomAnchorController.handleViewportMetricsChange({
        previousViewportWidth,
        viewportWidth,
        previousViewportHeight,
        viewportHeight,
      });
      reportReadingPosition();
      evaluateHistoryStart();
    },
  );

  const handleContentSizeChange = useStableEvent(
    (origin: NativeViewportLifetime, _width: number, height: number) => {
      if (!isCurrentViewport(origin)) return;
      measuredContentIdentity.current = flatListRef.current;
      const previousContentHeight = streamViewportMetricsRef.current.contentHeight;
      const nextContentHeight = Math.max(0, height);
      streamViewportMetricsRef.current = {
        ...streamViewportMetricsRef.current,
        containerKey: "native-virtualized",
        contentHeight: nextContentHeight,
        contentMeasuredForKey: "native-virtualized",
      };
      publishMeasuredNearBottom();
      bottomAnchorController.handleContentSizeChange({
        previousContentHeight,
        contentHeight: nextContentHeight,
      });
      evaluateHistoryStart();
      if (historyStartPaginationStateRef.current.status === "settling") {
        scheduleHistoryStartSettle();
      }
    },
  );

  const viewportHandlers = useMemo<NativeViewportHandlers>(
    () => ({
      refEffects: viewportRefEffects,
      onLayout: handleListLayout,
      onContentSizeChange: handleContentSizeChange,
      onScroll: handleScroll,
      onScrollBeginDrag: handleScrollBeginDrag,
      onScrollEndDrag: handleScrollEndDrag,
      onMomentumScrollBegin: handleMomentumScrollBegin,
      onMomentumScrollEnd: handleMomentumScrollEnd,
    }),
    [
      viewportRefEffects,
      handleListLayout,
      handleContentSizeChange,
      handleScroll,
      handleScrollBeginDrag,
      handleScrollEndDrag,
      handleMomentumScrollBegin,
      handleMomentumScrollEnd,
    ],
  );

  useEffect(() => {
    evaluateHistoryStart();
    if (historyStartPaginationStateRef.current.status === "settling") {
      scheduleHistoryStartSettle();
    }
  }, [
    evaluateHistoryStart,
    hasOlderHistory,
    isLoadingOlderHistory,
    olderHistoryProgressKey,
    scheduleHistoryStartSettle,
  ]);

  const handleScrollToIndexFailed = promptJumpController.handleIndexFailure;

  const recordRow = useStableEvent((id: string, geometry: ActualNativeRowGeometry) => {
    if (historyItems[geometry.index]?.id !== id) return;
    const previous = actualGeometry.current.get(id);
    if (
      previous?.y === geometry.y &&
      previous.height === geometry.height &&
      previous.index === geometry.index &&
      previous.pinnedHeight === geometry.pinnedHeight
    )
      return;
    actualGeometry.current.set(id, geometry);
    measuredHeaders.record(id, geometry);
    setGeometryRevision((value) => value + 1);
    reportReadingPosition();
  });
  const renderItem = useStableEvent(
    ({ item, index }: ListRenderItemInfo<StreamItem>): ReactElement | null => (
      <ActualPinnedRowContext.Provider value={pinnedId === item.id}>
        {segments.liveHead.some((live) => live.id === item.id)
          ? renderLiveHeadRow(item, index, historyItems)
          : renderHistoryMountedRow(item, index, historyItems)}
      </ActualPinnedRowContext.Provider>
    ),
  );
  const markRowMounted = useStableEvent((id: string, mounted: boolean) => {
    if (mounted) mountedRows.current.add(id);
    else {
      mountedRows.current.delete(id);
      paintedRows.current.delete(id);
    }
  });
  const recordPaintedRow = useStableEvent((measurement: PaintedNativeRowMeasurement) => {
    const { binding, item, index, height } = measurement;
    if (binding.items[index] !== item) return;
    if (!(height > 0) || !Number.isFinite(height)) {
      // A later zero frame invalidates this binding's earlier positive frame.
      if (paintedRows.current.get(item.id)?.binding === binding)
        paintedRows.current.delete(item.id);
      return;
    }
    paintedRows.current.set(item.id, { binding, id: item.id, index, height, mounted: true });
    bottomAnchorController.notifyPaintedNativeTailMaybeChanged();
  });
  const CellRendererComponent = useMemo(
    () =>
      createActualCellRenderer({
        record: recordRow,
        mount: markRowMounted,
        recordPainted: recordPaintedRow,
      }),
    [recordRow, markRowMounted, recordPaintedRow],
  );
  const stickyHeaderIndices = useMemo(
    () => historyItems.flatMap((item, index) => (item.kind === "user_message" ? [index + 1] : [])),
    [historyItems],
  );
  const listExtraData = useMemo(
    () => ({
      historyRowRevision,
      liveHeadRowRevision,
      pinnedId,
      expanded: actualRows?.expandedIds,
      geometryRevision,
    }),
    [historyRowRevision, liveHeadRowRevision, pinnedId, actualRows?.expandedIds, geometryRevision],
  );
  useEffect(() => {
    const ids = new Set(historyItems.map((item) => item.id));
    for (const id of actualGeometry.current.keys())
      if (!ids.has(id)) actualGeometry.current.delete(id);
  }, [historyItems]);
  const historyFooterContent = useMemo(() => {
    const isLoadingOperation = isHistoryStartLoadingOperation(historyStartPaginationState);
    return (
      <View style={historyStartSlotStyle} testID="older-history-slot">
        {isLoadingOperation ? (
          <View testID="load-older-history-spinner">
            <ThemedLoadingSpinner size="small" uniProps={foregroundMutedColorMapping} />
          </View>
        ) : null}
      </View>
    );
  }, [historyStartPaginationState]);

  const footerContent = useMemo(() => <View>{renderLiveAuxiliary()}</View>, [renderLiveAuxiliary]);
  const emptyContent = useMemo(() => <View>{listEmptyComponent}</View>, [listEmptyComponent]);
  // One stable cell type and key cover both history and live revisions. RN retains
  // the closest preceding sticky cell in its own render mask (loader offset1).
  return (
    <NativeStickyViewportProvider value={nativeStickyViewport}>
      <NativePaintedTailBindingContext.Provider value={paintedBinding}>
        <NativeViewportList
          {...listInsetProps}
          viewportHandlers={viewportHandlers}
          data={historyRows}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          strictMode
          testID="agent-chat-scroll"
          nativeID="agent-chat-scroll-native-virtualized"
          CellRendererComponent={CellRendererComponent}
          extraData={listExtraData}
          stickyHeaderIndices={stickyHeaderIndices}
          StickyHeaderComponent={ActualStickyHeader}
          ListHeaderComponent={historyFooterContent}
          ListHeaderComponentStyle={leadingSlotStyle}
          ListFooterComponent={footerContent}
          ListEmptyComponent={emptyContent}
          contentContainerStyle={listContentContainerStyle}
          style={listStyle}
          scrollEventThrottle={16}
          maintainVisibleContentPosition={maintainVisibleContentPosition}
          onScrollToIndexFailed={handleScrollToIndexFailed}
          onViewableItemsChanged={handleViewableItemsChanged}
          viewabilityConfig={viewabilityConfig}
          // Tall Markdown rows need larger refill batches during native flings.
          initialNumToRender={2}
          maxToRenderPerBatch={10}
          windowSize={NATIVE_STREAM_WINDOW_SIZE}
          removeClippedSubviews={false}
          scrollEnabled={scrollEnabled}
          showsVerticalScrollIndicator
        />
      </NativePaintedTailBindingContext.Provider>
    </NativeStickyViewportProvider>
  );
}

export function createNativeStreamStrategy(): StreamStrategy {
  const strategy = createStreamStrategy({
    render: (renderInput) => <NativeStreamViewport {...renderInput} strategy={strategy} />,
    orderTailReverse: false,
    orderHeadReverse: false,
    assistantTurnTraversalStep: -1,
    edgeSlot: "footer",
    historyLiveBoundaryEdge: "last",
    liveHeadHistoryBoundaryEdge: "first",
    frameChildOrder: "content-then-footer",
    flatListInverted: false,
    overlayScrollbarInverted: false,
    maintainVisibleContentPosition: DEFAULT_MAINTAIN_VISIBLE_CONTENT_POSITION,
    bottomAnchorTransportBehavior: {
      verificationDelayFrames: 2,
      verificationRetryMode: "recheck",
    },
    disableParentScrollOnInlineDetailsExpansion: false,
    anchorBottomOnContentSizeChange: false,
    animateManualScrollToBottom: true,
    useVirtualizedList: true,
    isNearBottom: (input) =>
      nativeBottomDistance(input.contentHeight, 0, input.viewportHeight, input.offsetY) <=
      input.threshold,
    getBottomOffset: (input) => Math.max(0, input.contentHeight - input.viewportHeight),
  });
  return strategy;
}
