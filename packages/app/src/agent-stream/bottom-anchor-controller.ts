import { useEffect, useRef, useState } from "react";
import type { BottomAnchorTransportBehavior } from "./strategy";

export type BottomAnchorMode = "sticky-bottom" | "detached";

export interface BottomAnchorRouteRequest {
  reason: "initial-entry" | "resume";
  agentId: string;
  requestKey: string;
}

export interface BottomAnchorLocalRequest {
  reason: "jump-to-bottom" | "message-sent" | "rewind";
  agentId: string;
}

/** Native layout evidence is scoped to one committed route, data snapshot and held list. */
export interface PaintedNativeTailBinding {
  agentId: string;
  requestKey: string;
  containerKey: string;
  items: readonly { id: string }[];
  scopeIdentity: object;
  viewportIdentity: object;
}

/** A positive native cell frame, captured under its own committed binding. */
export interface PaintedNativeTailRow {
  binding: PaintedNativeTailBinding;
  id: string;
  index: number;
  height: number;
  mounted: boolean;
}

/** The caller must retain both current measurements and mounted-row identity. */
export interface PaintedNativeTailEvidence {
  current: PaintedNativeTailBinding;
  row: PaintedNativeTailRow;
}

/** Terminal work belongs to the driver, agent, request and gesture that began it. */
export interface BottomAnchorUserScroll {
  finish(params: { isNearBottom: boolean }): void;
  retire(): void;
}

interface PaintedNativeTailGeometry {
  binding: PaintedNativeTailBinding;
  viewportWidth: number;
  viewportHeight: number;
  contentHeight: number;
}

interface PaintedNativeLanding {
  requestId: number;
  geometry: PaintedNativeTailGeometry;
}

export type BottomAnchorBlockedReason =
  | "waiting_for_history_readiness"
  | "waiting_for_measurable_viewport"
  | "waiting_for_measurable_content"
  | "waiting_for_post_layout_verification";

type BottomAnchorRequestReason =
  | BottomAnchorRouteRequest["reason"]
  | BottomAnchorLocalRequest["reason"];

interface BottomAnchorRequest {
  id: number;
  agentId: string;
  reason: BottomAnchorRequestReason;
  requestKey: string;
}

interface ControllerMeasurementState {
  containerKey: string;
  viewportWidth: number;
  viewportHeight: number;
  contentHeight: number;
  offsetY: number;
  viewportMeasuredForKey: string | null;
  contentMeasuredForKey: string | null;
}

interface AttemptContext {
  requestId: number | null;
  retries: number;
  confirmationPasses?: number;
  startedContentHeight?: number;
  startedOffsetY?: number;
  startedViewportHeight?: number;
  paintedGeometry?: PaintedNativeTailGeometry;
}

interface ScheduledFrameHandle {
  cancelled: boolean;
  rafId: number | null;
  remainingFrames: number;
  callback: () => void;
}

interface BottomAnchorControllerDriver {
  destroy: () => void;
  getSnapshot: () => {
    mode: BottomAnchorMode;
    pendingRequest: BottomAnchorRequest | null;
    pendingVerification: AttemptContext | null;
    blockedReason: BottomAnchorBlockedReason | null;
  };
  resetForAgent: () => void;
  applyRouteRequest: (request: BottomAnchorRouteRequest | null) => void;
  requestLocalAnchor: (request: BottomAnchorLocalRequest) => void;
  beginUserScroll: () => BottomAnchorUserScroll;
  endUserScroll: (params: { isNearBottom: boolean }) => void;
  detachByUser: () => void;
  handleViewportMetricsChange: (params: {
    previousViewportWidth: number;
    viewportWidth: number;
    previousViewportHeight: number;
    viewportHeight: number;
  }) => void;
  handleContentSizeChange: (params: {
    previousContentHeight: number;
    contentHeight: number;
  }) => void;
  prepareForStickyViewportChange: () => void;
  prepareForStickyContentChange: () => void;
  handleScrollNearBottomChange: (params: {
    nextIsNearBottom: boolean;
    scrollDelta: number;
  }) => void;
  notifyAuthoritativeHistoryMaybeChanged: () => void;
  notifyPaintedNativeTailMaybeChanged: () => void;
  reevaluate: (animated?: boolean) => void;
}

interface CreateBottomAnchorControllerDriverInput {
  getAgentId: () => string;
  getIsAuthoritativeHistoryReady: () => boolean;
  getRenderStrategy: () => string;
  getTransportBehavior: () => BottomAnchorTransportBehavior;
  getMeasurementState: () => ControllerMeasurementState;
  getPaintedNativeTailEvidence?: () => PaintedNativeTailEvidence | null;
  isNearBottom: () => boolean;
  scrollToBottom: (animated: boolean) => void;
  onModeChange: (mode: BottomAnchorMode) => void;
  scheduleFrame: (params: {
    kind: "attempt" | "verification";
    callback: () => void;
    delayFrames?: number;
  }) => unknown;
  cancelFrame: (handle: unknown) => void;
}

const MAX_VERIFICATION_RETRIES = 3;
const WEB_PARTIAL_VIRTUALIZED_CONFIRMATION_DELAY_FRAMES = 1;
const USER_SCROLL_AWAY_DELTA_PX = 24;

/** Bind a physical painted row to the exact current conversation and viewport. */
function samePaintedNativeBinding(left: PaintedNativeTailBinding, right: PaintedNativeTailBinding) {
  return (
    left.agentId === right.agentId &&
    left.requestKey === right.requestKey &&
    left.containerKey === right.containerKey &&
    left.items === right.items &&
    left.scopeIdentity === right.scopeIdentity &&
    left.viewportIdentity === right.viewportIdentity
  );
}

function samePaintedNativeGeometry(
  left: PaintedNativeTailGeometry,
  right: PaintedNativeTailGeometry,
) {
  return (
    samePaintedNativeBinding(left.binding, right.binding) &&
    left.viewportWidth === right.viewportWidth &&
    left.viewportHeight === right.viewportHeight &&
    left.contentHeight === right.contentHeight
  );
}

function hasPaintedNativeMeasurements(metrics: ControllerMeasurementState) {
  const currentViewport =
    metrics.viewportHeight > 0 &&
    metrics.viewportWidth > 0 &&
    metrics.viewportMeasuredForKey === metrics.containerKey;
  const currentContent =
    metrics.contentHeight > 0 && metrics.contentMeasuredForKey === metrics.containerKey;
  return currentViewport && currentContent && metrics.containerKey === "native-virtualized";
}

function isCurrentPaintedNativeRow({ current, row }: PaintedNativeTailEvidence) {
  return (
    samePaintedNativeBinding(current, row.binding) &&
    row.mounted &&
    row.height > 0 &&
    Number.isFinite(row.height) &&
    Number.isInteger(row.index) &&
    row.index >= 0 &&
    current.items[row.index]?.id === row.id
  );
}

interface PaintedNativeTailInput {
  input: CreateBottomAnchorControllerDriverInput;
  request: BottomAnchorRequest | null;
  metrics: ControllerMeasurementState;
}

/** Painted content permits only a provisional native route landing, never history readiness. */
function getPaintedNativeTailGeometry({
  input,
  request,
  metrics,
}: PaintedNativeTailInput): PaintedNativeTailGeometry | null {
  if (!request || (request.reason !== "initial-entry" && request.reason !== "resume")) return null;
  if (input.getRenderStrategy() !== "chronological-native-stream") return null;
  const evidence = input.getPaintedNativeTailEvidence?.();
  if (!evidence) return null;
  if (!hasPaintedNativeMeasurements(metrics)) return null;
  const { current } = evidence;
  const currentRoute =
    current.agentId === input.getAgentId() &&
    current.agentId === request.agentId &&
    current.requestKey === request.requestKey &&
    current.containerKey === metrics.containerKey;
  if (!currentRoute || !isCurrentPaintedNativeRow(evidence)) return null;
  return {
    binding: current,
    viewportWidth: metrics.viewportWidth,
    viewportHeight: metrics.viewportHeight,
    contentHeight: metrics.contentHeight,
  };
}

function scheduleAnimationFrameWithDelay(input: {
  callback: () => void;
  delayFrames?: number;
}): ScheduledFrameHandle {
  const handle: ScheduledFrameHandle = {
    cancelled: false,
    rafId: null,
    remainingFrames: Math.max(0, input.delayFrames ?? 0),
    callback: input.callback,
  };

  const tick = () => {
    if (handle.cancelled) {
      return;
    }
    if (handle.remainingFrames > 0) {
      handle.remainingFrames -= 1;
      handle.rafId = requestAnimationFrame(tick);
      return;
    }
    handle.rafId = null;
    input.callback();
  };

  handle.rafId = requestAnimationFrame(tick);
  return handle;
}

function cancelScheduledAnimationFrame(handle: unknown): void {
  const scheduled = handle as ScheduledFrameHandle | null;
  if (!scheduled) {
    return;
  }
  scheduled.cancelled = true;
  if (scheduled.rafId !== null) {
    cancelAnimationFrame(scheduled.rafId);
    scheduled.rafId = null;
  }
}

function deriveVerificationBlockedReason(input: {
  isAuthoritativeHistoryReady: boolean;
  measurementState: ControllerMeasurementState;
}): Exclude<BottomAnchorBlockedReason, "waiting_for_post_layout_verification"> | null {
  if (!input.isAuthoritativeHistoryReady) {
    return "waiting_for_history_readiness";
  }
  if (
    input.measurementState.viewportHeight <= 0 ||
    input.measurementState.viewportMeasuredForKey !== input.measurementState.containerKey
  ) {
    return "waiting_for_measurable_viewport";
  }
  if (
    input.measurementState.contentHeight <= 0 ||
    input.measurementState.contentMeasuredForKey !== input.measurementState.containerKey
  ) {
    return "waiting_for_measurable_content";
  }
  return null;
}

export function deriveBottomAnchorBlockedReason(input: {
  pendingRequest: BottomAnchorRequest | null;
  isAuthoritativeHistoryReady: boolean;
  measurementState: ControllerMeasurementState;
  pendingVerificationRequestId: number | null;
}): BottomAnchorBlockedReason | null {
  if (!input.pendingRequest) {
    return null;
  }
  if (!input.isAuthoritativeHistoryReady) {
    return "waiting_for_history_readiness";
  }
  if (
    input.measurementState.viewportHeight <= 0 ||
    input.measurementState.viewportMeasuredForKey !== input.measurementState.containerKey
  ) {
    return "waiting_for_measurable_viewport";
  }
  if (
    input.measurementState.contentHeight <= 0 ||
    input.measurementState.contentMeasuredForKey !== input.measurementState.containerKey
  ) {
    return "waiting_for_measurable_content";
  }
  if (input.pendingVerificationRequestId === input.pendingRequest.id) {
    return "waiting_for_post_layout_verification";
  }
  return null;
}

function deriveRetryDisposition(input: {
  mode: BottomAnchorMode;
  retries: number;
  verificationRetryMode: BottomAnchorTransportBehavior["verificationRetryMode"];
}): "retry-scroll" | "retry-verify" | "fail" {
  if (input.mode !== "sticky-bottom" || input.retries >= MAX_VERIFICATION_RETRIES) {
    return "fail";
  }
  return input.verificationRetryMode === "recheck" ? "retry-verify" : "retry-scroll";
}

function shouldRequireRouteRequestConfirmation(input: {
  request: BottomAnchorRequest | null;
  measurementState: ControllerMeasurementState;
  confirmationPasses: number;
}): boolean {
  if (!input.request) {
    return false;
  }
  if (input.request.reason !== "initial-entry" && input.request.reason !== "resume") {
    return false;
  }
  if (input.measurementState.containerKey !== "web-partial-virtualized") {
    return false;
  }
  return input.confirmationPasses < 1;
}

function createBottomAnchorControllerDriver(
  input: CreateBottomAnchorControllerDriverInput,
): BottomAnchorControllerDriver {
  let requestSequence = 0;
  let mode: BottomAnchorMode = "sticky-bottom";
  let pendingRequest: BottomAnchorRequest | null = null;
  let pendingVerification: AttemptContext | null = null;
  let paintedLanding: PaintedNativeLanding | null = null;
  let blockedReason: BottomAnchorBlockedReason | null = null;
  let attemptHandle: unknown = null;
  let verificationHandle: unknown = null;
  let lastRouteRequestKey: string | null = null;
  let stickyMeasurementRevision = 0;
  let lastVerifiedStickyMeasurementRevision = 0;
  let isUserScrollActive = false;
  let activeUserScrollOwner: object | null = null;

  const setBlockedReason = (nextBlockedReason: BottomAnchorBlockedReason | null) => {
    if (blockedReason === nextBlockedReason) {
      return;
    }
    blockedReason = nextBlockedReason;
  };

  const setModeInternal = (nextMode: BottomAnchorMode) => {
    if (mode === nextMode) {
      return;
    }
    mode = nextMode;
    input.onModeChange(nextMode);
    if (nextMode === "detached") {
      lastVerifiedStickyMeasurementRevision = stickyMeasurementRevision;
    }
  };

  const markStickyMeasurementChanged = () => {
    stickyMeasurementRevision += 1;
  };

  const markStickyMeasurementVerified = () => {
    lastVerifiedStickyMeasurementRevision = stickyMeasurementRevision;
  };

  const cancelPendingAttempt = () => {
    if (attemptHandle) {
      input.cancelFrame(attemptHandle);
      attemptHandle = null;
    }
    if (verificationHandle) {
      input.cancelFrame(verificationHandle);
      verificationHandle = null;
    }
    pendingVerification = null;
  };

  const cancelPendingRequest = (_reason: string) => {
    paintedLanding = null;
    const currentRequest = pendingRequest;
    if (!currentRequest) {
      cancelPendingAttempt();
      setBlockedReason(null);
      return;
    }
    pendingRequest = null;
    cancelPendingAttempt();
    setBlockedReason(null);
  };

  const deriveDriverBlockedReason = (measurementState: ControllerMeasurementState) =>
    deriveBottomAnchorBlockedReason({
      pendingRequest,
      isAuthoritativeHistoryReady: input.getIsAuthoritativeHistoryReady(),
      measurementState,
      pendingVerificationRequestId:
        verificationHandle !== null ? (pendingVerification?.requestId ?? null) : null,
    });

  /** Physical verification retires attempt debt; authority still owns route completion. */
  function settlePaintedLanding() {
    pendingVerification = null;
    markStickyMeasurementVerified();
    if (!input.getIsAuthoritativeHistoryReady()) {
      setBlockedReason("waiting_for_history_readiness");
      return;
    }
    pendingRequest = null;
    paintedLanding = null;
    setBlockedReason(null);
  }

  function blockPaintedLanding() {
    setBlockedReason(
      input.getIsAuthoritativeHistoryReady()
        ? "waiting_for_post_layout_verification"
        : "waiting_for_history_readiness",
    );
  }

  /** Recheck observed native state within the existing three-retry frame budget.
   * Unchanged geometry never causes another command, even after that budget ends.
   */
  function verifyPaintedLanding(attempt: AttemptContext, expected: PaintedNativeTailGeometry) {
    const geometry = getPaintedNativeTailGeometry({
      input,
      request: pendingRequest,
      metrics: input.getMeasurementState(),
    });
    if (!geometry || pendingRequest?.id !== attempt.requestId || !paintedLanding) {
      pendingVerification = null;
      paintedLanding = null;
      setBlockedReason(deriveDriverBlockedReason(input.getMeasurementState()));
      return;
    }
    if (!samePaintedNativeGeometry(geometry, expected)) {
      pendingVerification = null;
      evaluate(false, "painted_content_change");
      return;
    }
    if (input.isNearBottom()) {
      settlePaintedLanding();
      return;
    }
    if (attempt.retries < MAX_VERIFICATION_RETRIES) {
      pendingVerification = { ...attempt, retries: attempt.retries + 1 };
      scheduleVerification(pendingVerification);
    } else {
      pendingVerification = null;
    }
    blockPaintedLanding();
  }

  /** Keep one provisional command per current target geometry under the same request. */
  function tryPaintedLanding(metrics: ControllerMeasurementState): boolean {
    const geometry = getPaintedNativeTailGeometry({ input, request: pendingRequest, metrics });
    if (!geometry || !pendingRequest) {
      if (pendingVerification?.paintedGeometry) cancelPendingAttempt();
      paintedLanding = null;
      return false;
    }
    const previous = paintedLanding;
    const unchanged =
      previous !== null &&
      previous.requestId === pendingRequest.id &&
      samePaintedNativeGeometry(previous.geometry, geometry);
    if (unchanged) {
      if (!pendingVerification && input.isNearBottom()) {
        settlePaintedLanding();
      } else {
        blockPaintedLanding();
      }
      return true;
    }
    cancelPendingAttempt();
    paintedLanding = { requestId: pendingRequest.id, geometry };
    if (input.isNearBottom()) {
      settlePaintedLanding();
      return true;
    }
    pendingVerification = {
      requestId: pendingRequest.id,
      retries: 0,
      paintedGeometry: geometry,
      startedContentHeight: metrics.contentHeight,
      startedOffsetY: metrics.offsetY,
      startedViewportHeight: metrics.viewportHeight,
    };
    input.scrollToBottom(false);
    scheduleVerification(pendingVerification);
    blockPaintedLanding();
    return true;
  }

  const scheduleVerification = (attemptContext: AttemptContext, delayFramesOverride?: number) => {
    if (verificationHandle) {
      input.cancelFrame(verificationHandle);
    }
    verificationHandle = input.scheduleFrame({
      kind: "verification",
      delayFrames: delayFramesOverride ?? input.getTransportBehavior().verificationDelayFrames,
      callback: () => {
        verificationHandle = null;
        if (attemptContext.paintedGeometry) {
          verifyPaintedLanding(attemptContext, attemptContext.paintedGeometry);
          return;
        }
        const currentRequest = pendingRequest;
        const isRequestAttempt = currentRequest && attemptContext.requestId === currentRequest.id;
        const measurementState = input.getMeasurementState();
        const verificationBlockedReason = deriveVerificationBlockedReason({
          isAuthoritativeHistoryReady: input.getIsAuthoritativeHistoryReady(),
          measurementState,
        });

        if (verificationBlockedReason) {
          pendingVerification = attemptContext;
          setBlockedReason(verificationBlockedReason);
          return;
        }

        const verifiedNearBottom = input.isNearBottom();
        const retryDisposition = verifiedNearBottom
          ? null
          : deriveRetryDisposition({
              mode,
              retries: attemptContext.retries,
              verificationRetryMode: input.getTransportBehavior().verificationRetryMode,
            });

        if (verifiedNearBottom) {
          if (
            isRequestAttempt &&
            shouldRequireRouteRequestConfirmation({
              request: currentRequest,
              measurementState,
              confirmationPasses: attemptContext.confirmationPasses ?? 0,
            })
          ) {
            pendingVerification = {
              ...attemptContext,
              confirmationPasses: (attemptContext.confirmationPasses ?? 0) + 1,
            };
            setBlockedReason("waiting_for_post_layout_verification");
            scheduleVerification(
              pendingVerification,
              WEB_PARTIAL_VIRTUALIZED_CONFIRMATION_DELAY_FRAMES,
            );
            return;
          }
          pendingVerification = null;
          markStickyMeasurementVerified();
          if (isRequestAttempt) {
            pendingRequest = null;
          }
          setBlockedReason(null);
          return;
        }

        if (retryDisposition === "retry-verify") {
          pendingVerification = {
            requestId: attemptContext.requestId,
            retries: attemptContext.retries + 1,
          };
          setBlockedReason("waiting_for_post_layout_verification");
          scheduleVerification(pendingVerification);
          return;
        }

        if (retryDisposition === "retry-scroll") {
          pendingVerification = {
            requestId: attemptContext.requestId,
            retries: attemptContext.retries + 1,
          };
          evaluate(false, "retry_scroll");
          return;
        }

        pendingVerification = null;
        setBlockedReason(isRequestAttempt ? "waiting_for_post_layout_verification" : null);
      },
    });
  };

  const runAttempt = (animated: boolean) => {
    const measurementState = input.getMeasurementState();
    const attemptContext: AttemptContext = {
      requestId: pendingRequest?.id ?? null,
      retries: pendingVerification?.retries ?? 0,
      startedContentHeight: measurementState.contentHeight,
      startedOffsetY: measurementState.offsetY,
      startedViewportHeight: measurementState.viewportHeight,
    };
    pendingVerification = attemptContext;
    input.scrollToBottom(animated);
    scheduleVerification(attemptContext);
    setBlockedReason(deriveDriverBlockedReason(input.getMeasurementState()));
  };

  const evaluate = (
    animated: boolean,
    _reason:
      | "request_created"
      | "viewport_change"
      | "content_size_change"
      | "scroll_near_bottom_change"
      | "user_scroll_end"
      | "history_readiness_change"
      | "manual_reevaluate"
      | "retry_scroll"
      | "painted_content_change"
      | "viewport_gesture_retired",
  ) => {
    if (isUserScrollActive) {
      return;
    }
    if (attemptHandle) {
      return;
    }
    attemptHandle = input.scheduleFrame({
      kind: "attempt",
      callback: () => {
        attemptHandle = null;
        const measurementState = input.getMeasurementState();
        if (tryPaintedLanding(measurementState)) return;
        const nextBlockedReason = deriveDriverBlockedReason(measurementState);
        setBlockedReason(nextBlockedReason);

        const shouldAttemptForPendingRequest =
          pendingRequest !== null && nextBlockedReason === null;
        const shouldAttemptForStickyVerification =
          mode === "sticky-bottom" && pendingVerification !== null && nextBlockedReason === null;

        if (!shouldAttemptForPendingRequest && !shouldAttemptForStickyVerification) {
          return;
        }

        runAttempt(animated);
      },
    });
  };

  const createRequest = (request: BottomAnchorRouteRequest | BottomAnchorLocalRequest) => {
    cancelPendingAttempt();
    paintedLanding = null;
    const nextRequest: BottomAnchorRequest = {
      id: requestSequence + 1,
      agentId: request.agentId,
      reason: request.reason,
      requestKey:
        "requestKey" in request
          ? request.requestKey
          : `${request.agentId}:${request.reason}:${requestSequence + 1}`,
    };
    requestSequence = nextRequest.id;
    pendingRequest = nextRequest;
    pendingVerification = null;
    setModeInternal(
      "requestKey" in request
        ? "sticky-bottom"
        : __private__.deriveModeForLocalRequest({ reason: request.reason }),
    );
    evaluate(request.reason === "jump-to-bottom", "request_created");
  };

  return {
    destroy() {
      activeUserScrollOwner = null;
      isUserScrollActive = false;
      cancelPendingAttempt();
    },
    getSnapshot() {
      return {
        mode,
        pendingRequest,
        pendingVerification,
        blockedReason,
      };
    },
    resetForAgent() {
      lastRouteRequestKey = null;
      pendingRequest = null;
      paintedLanding = null;
      blockedReason = null;
      cancelPendingAttempt();
      stickyMeasurementRevision = 0;
      lastVerifiedStickyMeasurementRevision = 0;
      isUserScrollActive = false;
      activeUserScrollOwner = null;
      mode = "sticky-bottom";
      input.onModeChange("sticky-bottom");
    },
    applyRouteRequest(request) {
      if (!request) {
        return;
      }
      if (lastRouteRequestKey === request.requestKey) {
        return;
      }
      lastRouteRequestKey = request.requestKey;
      createRequest(request);
    },
    requestLocalAnchor(request) {
      createRequest(request);
    },
    beginUserScroll(): BottomAnchorUserScroll {
      isUserScrollActive = true;
      cancelPendingAttempt();
      paintedLanding = null;
      const owner = {};
      const startedRequestSequence = requestSequence;
      const startedAgent = input.getAgentId();
      activeUserScrollOwner = owner;
      const finishUserScroll = this.endUserScroll.bind(this);

      // Departure cannot certify bottom. Retire only this gesture and preserve
      // any route/local request that replaced the one active when it began.
      function retireViewportGesture() {
        if (activeUserScrollOwner !== owner) return;
        activeUserScrollOwner = null;
        isUserScrollActive = false;
        if (input.getAgentId() !== startedAgent) return;
        if (requestSequence !== startedRequestSequence) {
          if (pendingRequest) evaluate(false, "viewport_gesture_retired");
          return;
        }
        if (mode === "sticky-bottom") {
          cancelPendingRequest("viewport_gesture_departed");
          setModeInternal("detached");
        }
      }
      return {
        finish(params) {
          if (activeUserScrollOwner !== owner) return;
          if (input.getAgentId() !== startedAgent || requestSequence !== startedRequestSequence) {
            retireViewportGesture();
            return;
          }
          finishUserScroll(params);
        },
        retire: retireViewportGesture,
      };
    },
    endUserScroll(params) {
      activeUserScrollOwner = null;
      isUserScrollActive = false;
      if (params.isNearBottom) {
        if (mode === "detached") {
          setModeInternal("sticky-bottom");
          pendingVerification = { requestId: null, retries: 0 };
          evaluate(false, "user_scroll_end");
          return;
        }
        if (pendingRequest) {
          evaluate(false, "user_scroll_end");
          return;
        }
        if (
          !input.isNearBottom() ||
          stickyMeasurementRevision !== lastVerifiedStickyMeasurementRevision
        ) {
          pendingVerification = { requestId: null, retries: 0 };
          evaluate(false, "user_scroll_end");
          return;
        }
        markStickyMeasurementVerified();
        return;
      }
      if (mode === "sticky-bottom") {
        this.detachByUser();
      }
    },
    detachByUser() {
      if (mode === "detached") {
        return;
      }
      cancelPendingRequest("user_scrolled_away");
      setModeInternal("detached");
    },
    handleViewportMetricsChange(params) {
      if (
        params.previousViewportWidth !== params.viewportWidth ||
        params.previousViewportHeight !== params.viewportHeight
      ) {
        markStickyMeasurementChanged();
      }
      if (isUserScrollActive) {
        return;
      }
      const shouldRestick = __private__.shouldRestickOnViewportChange({
        mode,
        previousViewportWidth: params.previousViewportWidth,
        viewportWidth: params.viewportWidth,
        previousViewportHeight: params.previousViewportHeight,
        viewportHeight: params.viewportHeight,
      });
      if (shouldRestick && !pendingRequest) {
        pendingVerification = { requestId: null, retries: 0 };
      }
      if (shouldRestick || pendingRequest) {
        evaluate(false, "viewport_change");
      }
    },
    handleContentSizeChange(params) {
      if (params.previousContentHeight !== params.contentHeight) {
        markStickyMeasurementChanged();
      }
      if (isUserScrollActive) {
        return;
      }
      const shouldRestick = __private__.shouldRestickOnContentChange({
        mode,
        previousContentHeight: params.previousContentHeight,
        contentHeight: params.contentHeight,
      });
      if (shouldRestick && !pendingRequest) {
        pendingVerification = { requestId: null, retries: 0 };
        if (attemptHandle) {
          input.cancelFrame(attemptHandle);
          attemptHandle = null;
        }
        runAttempt(false);
        return;
      }
      if (shouldRestick || pendingRequest) {
        evaluate(false, "content_size_change");
      }
    },
    prepareForStickyViewportChange() {
      if (mode !== "sticky-bottom") {
        return;
      }
      markStickyMeasurementChanged();
    },
    prepareForStickyContentChange() {
      if (mode !== "sticky-bottom") {
        return;
      }
      markStickyMeasurementChanged();
      if (isUserScrollActive) {
        return;
      }
      if (!pendingRequest) {
        pendingVerification = { requestId: null, retries: 0 };
        if (attemptHandle) {
          input.cancelFrame(attemptHandle);
          attemptHandle = null;
        }
        runAttempt(false);
        return;
      }
      evaluate(false, "content_size_change");
    },
    handleScrollNearBottomChange(params) {
      const { nextIsNearBottom, scrollDelta } = params;
      if (isUserScrollActive) {
        return;
      }
      if (
        nextIsNearBottom &&
        mode === "sticky-bottom" &&
        stickyMeasurementRevision !== lastVerifiedStickyMeasurementRevision
      ) {
        markStickyMeasurementVerified();
      }
      const hasUnverifiedStickyMeasurementChange =
        stickyMeasurementRevision !== lastVerifiedStickyMeasurementRevision;
      if (
        __private__.shouldDetachFromScrollAway({
          mode,
          nextIsNearBottom,
          scrollDelta,
          hasPendingRequest: pendingRequest !== null,
          hasPendingVerification: pendingVerification !== null,
          hasUnverifiedStickyMeasurementChange,
        })
      ) {
        this.detachByUser();
        return;
      }
      if (mode === "sticky-bottom" && !nextIsNearBottom && hasUnverifiedStickyMeasurementChange) {
        if (!pendingRequest && !pendingVerification) {
          pendingVerification = { requestId: null, retries: 0 };
        }
        evaluate(false, "scroll_near_bottom_change");
        return;
      }
      if (nextIsNearBottom && pendingRequest) {
        evaluate(false, "scroll_near_bottom_change");
      }
    },
    notifyAuthoritativeHistoryMaybeChanged() {
      if (!pendingVerification && !pendingRequest) {
        return;
      }
      evaluate(false, "history_readiness_change");
    },
    notifyPaintedNativeTailMaybeChanged() {
      if (
        getPaintedNativeTailGeometry({
          input,
          request: pendingRequest,
          metrics: input.getMeasurementState(),
        })
      ) {
        evaluate(false, "painted_content_change");
      }
    },
    reevaluate(animated = false) {
      evaluate(animated, "manual_reevaluate");
    },
  };
}

export const __private__ = {
  createBottomAnchorControllerDriver,
  deriveBottomAnchorBlockedReason,
  deriveVerificationBlockedReason,
  deriveRetryDisposition,
  deriveModeForLocalRequest(_input: {
    reason: BottomAnchorLocalRequest["reason"];
  }): BottomAnchorMode {
    return "sticky-bottom";
  },
  shouldRestickOnViewportChange(input: {
    mode: BottomAnchorMode;
    previousViewportWidth: number;
    viewportWidth: number;
    previousViewportHeight: number;
    viewportHeight: number;
  }): boolean {
    return (
      input.mode === "sticky-bottom" &&
      ((input.previousViewportHeight > 0 &&
        input.viewportHeight > 0 &&
        input.previousViewportHeight !== input.viewportHeight) ||
        (input.previousViewportWidth > 0 &&
          input.viewportWidth > 0 &&
          input.previousViewportWidth !== input.viewportWidth))
    );
  },
  shouldRestickOnContentChange(input: {
    mode: BottomAnchorMode;
    previousContentHeight: number;
    contentHeight: number;
  }): boolean {
    return input.mode === "sticky-bottom" && input.contentHeight > input.previousContentHeight;
  },
  shouldDetachFromScrollAway(input: {
    mode: BottomAnchorMode;
    nextIsNearBottom: boolean;
    scrollDelta: number;
    hasPendingRequest: boolean;
    hasPendingVerification: boolean;
    hasUnverifiedStickyMeasurementChange: boolean;
  }): boolean {
    const scrolledAwayIntentionally = Math.abs(input.scrollDelta) >= USER_SCROLL_AWAY_DELTA_PX;
    return (
      input.mode === "sticky-bottom" &&
      !input.nextIsNearBottom &&
      !input.hasPendingRequest &&
      !input.hasPendingVerification &&
      (!input.hasUnverifiedStickyMeasurementChange || scrolledAwayIntentionally)
    );
  },
};

export function useBottomAnchorController(input: {
  agentId: string;
  routeRequest: BottomAnchorRouteRequest | null;
  isAuthoritativeHistoryReady: boolean;
  renderStrategy: string;
  getTransportBehavior: () => BottomAnchorTransportBehavior;
  getMeasurementState: () => ControllerMeasurementState;
  getPaintedNativeTailEvidence?: () => PaintedNativeTailEvidence | null;
  isNearBottom: () => boolean;
  scrollToBottom: (animated: boolean) => void;
}) {
  const [mode, setMode] = useState<BottomAnchorMode>("sticky-bottom");
  const agentIdRef = useRef(input.agentId);
  const readinessRef = useRef(input.isAuthoritativeHistoryReady);
  const renderStrategyRef = useRef(input.renderStrategy);
  const getTransportBehaviorRef = useRef(input.getTransportBehavior);
  const getMeasurementStateRef = useRef(input.getMeasurementState);
  const getPaintedNativeTailEvidenceRef = useRef(input.getPaintedNativeTailEvidence);
  const isNearBottomRef = useRef(input.isNearBottom);
  const scrollToBottomRef = useRef(input.scrollToBottom);
  const driverRef = useRef<BottomAnchorControllerDriver | null>(null);

  agentIdRef.current = input.agentId;
  readinessRef.current = input.isAuthoritativeHistoryReady;
  renderStrategyRef.current = input.renderStrategy;
  getTransportBehaviorRef.current = input.getTransportBehavior;
  getMeasurementStateRef.current = input.getMeasurementState;
  getPaintedNativeTailEvidenceRef.current = input.getPaintedNativeTailEvidence;
  isNearBottomRef.current = input.isNearBottom;
  scrollToBottomRef.current = input.scrollToBottom;

  if (!driverRef.current) {
    driverRef.current = __private__.createBottomAnchorControllerDriver({
      getAgentId: () => agentIdRef.current,
      getIsAuthoritativeHistoryReady: () => readinessRef.current,
      getRenderStrategy: () => renderStrategyRef.current,
      getTransportBehavior: () => getTransportBehaviorRef.current(),
      getMeasurementState: () => getMeasurementStateRef.current(),
      getPaintedNativeTailEvidence: () => getPaintedNativeTailEvidenceRef.current?.() ?? null,
      isNearBottom: () => isNearBottomRef.current(),
      scrollToBottom: (animated) => scrollToBottomRef.current(animated),
      onModeChange: (nextMode) => setMode(nextMode),
      scheduleFrame: ({ callback, delayFrames }) =>
        scheduleAnimationFrameWithDelay({ callback, delayFrames }),
      cancelFrame: (handle) => cancelScheduledAnimationFrame(handle),
    });
  }

  useEffect(() => {
    driverRef.current?.resetForAgent();
  }, [input.agentId]);

  useEffect(() => {
    driverRef.current?.applyRouteRequest(input.routeRequest);
  }, [input.routeRequest]);

  useEffect(() => {
    driverRef.current?.notifyAuthoritativeHistoryMaybeChanged();
  }, [input.isAuthoritativeHistoryReady]);

  useEffect(() => {
    return () => {
      driverRef.current?.destroy();
      driverRef.current = null;
    };
  }, []);

  return {
    mode,
    requestLocalAnchor(request: BottomAnchorLocalRequest) {
      driverRef.current?.requestLocalAnchor(request);
    },
    beginUserScroll() {
      return driverRef.current?.beginUserScroll();
    },
    endUserScroll(params: { isNearBottom: boolean }) {
      driverRef.current?.endUserScroll(params);
    },
    detachByUser() {
      driverRef.current?.detachByUser();
    },
    handleViewportLayout() {},
    handleViewportMetricsChange(params: {
      previousViewportWidth: number;
      viewportWidth: number;
      previousViewportHeight: number;
      viewportHeight: number;
    }) {
      driverRef.current?.handleViewportMetricsChange(params);
    },
    handleContentSizeChange(params: { previousContentHeight: number; contentHeight: number }) {
      driverRef.current?.handleContentSizeChange(params);
    },
    prepareForStickyViewportChange() {
      driverRef.current?.prepareForStickyViewportChange();
    },
    prepareForStickyContentChange() {
      driverRef.current?.prepareForStickyContentChange();
    },
    handleScrollNearBottomChange(params: { nextIsNearBottom: boolean; scrollDelta: number }) {
      driverRef.current?.handleScrollNearBottomChange(params);
    },
    notifyPaintedNativeTailMaybeChanged() {
      driverRef.current?.notifyPaintedNativeTailMaybeChanged();
    },
    reevaluate(animated = false) {
      driverRef.current?.reevaluate(animated);
    },
  };
}
