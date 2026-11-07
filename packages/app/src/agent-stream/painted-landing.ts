import type {
  AttemptContext,
  BottomAnchorBlockedReason,
  BottomAnchorRequest,
  ControllerMeasurementState,
  CreateBottomAnchorControllerDriverInput,
} from "./bottom-anchor-controller";

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

export interface PaintedNativeTailGeometry {
  binding: PaintedNativeTailBinding;
  viewportWidth: number;
  viewportHeight: number;
  contentHeight: number;
}

interface PaintedNativeLanding {
  requestId: number;
  geometry: PaintedNativeTailGeometry;
}

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

export function samePaintedNativeGeometry(
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
  input: PaintedNativeTailSource;
  request: BottomAnchorRequest | null;
  metrics: ControllerMeasurementState;
}

/** Painted content permits only a provisional native route landing, never history readiness. */
export function getPaintedNativeTailGeometry({
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

/** The driver inputs the painted landing reads. */
type PaintedNativeTailSource = Pick<
  CreateBottomAnchorControllerDriverInput,
  | "getAgentId"
  | "getIsAuthoritativeHistoryReady"
  | "getMeasurementState"
  | "getPaintedNativeTailEvidence"
  | "getRenderStrategy"
  | "isNearBottom"
  | "scrollToBottom"
>;

/** The bottom-anchor driver state the painted landing reads and updates. */
export interface PaintedLandingHost {
  input: PaintedNativeTailSource;
  maxRetries: number;
  getPendingRequest(): BottomAnchorRequest | null;
  clearPendingRequest(): void;
  getPendingVerification(): AttemptContext | null;
  setPendingVerification(attempt: AttemptContext | null): void;
  setBlockedReason(reason: BottomAnchorBlockedReason | null): void;
  deriveBlockedReason(metrics: ControllerMeasurementState): BottomAnchorBlockedReason | null;
  markVerified(): void;
  cancelPendingAttempt(): void;
  scheduleVerification(attempt: AttemptContext): void;
  evaluate(reason: string): void;
}

/**
 * The native route landing on painted tail evidence: one provisional scroll command per
 * request and target geometry, verified within the driver's retry budget. Painted content
 * never proves history readiness, so authority still owns route completion.
 */
export function createPaintedLanding(host: PaintedLandingHost) {
  const { input } = host;
  let landing: PaintedNativeLanding | null = null;

  /** Physical verification retires attempt debt; authority still owns route completion. */
  function settle() {
    host.setPendingVerification(null);
    host.markVerified();
    if (!input.getIsAuthoritativeHistoryReady()) {
      host.setBlockedReason("waiting_for_history_readiness");
      return;
    }
    host.clearPendingRequest();
    landing = null;
    host.setBlockedReason(null);
  }

  function block() {
    host.setBlockedReason(
      input.getIsAuthoritativeHistoryReady()
        ? "waiting_for_post_layout_verification"
        : "waiting_for_history_readiness",
    );
  }

  /** Recheck observed native state within the existing three-retry frame budget.
   * Unchanged geometry never causes another command, even after that budget ends.
   */
  function verify(attempt: AttemptContext, expected: PaintedNativeTailGeometry) {
    const request = host.getPendingRequest();
    const geometry = getPaintedNativeTailGeometry({
      input,
      request,
      metrics: input.getMeasurementState(),
    });
    if (!geometry || request?.id !== attempt.requestId || !landing) {
      host.setPendingVerification(null);
      landing = null;
      host.setBlockedReason(host.deriveBlockedReason(input.getMeasurementState()));
      return;
    }
    if (!samePaintedNativeGeometry(geometry, expected)) {
      host.setPendingVerification(null);
      host.evaluate("painted_content_change");
      return;
    }
    if (input.isNearBottom()) {
      settle();
      return;
    }
    if (attempt.retries < host.maxRetries) {
      const next = { ...attempt, retries: attempt.retries + 1 };
      host.setPendingVerification(next);
      host.scheduleVerification(next);
    } else {
      host.setPendingVerification(null);
    }
    block();
  }

  /** Keep one provisional command per current target geometry under the same request. */
  function tryLand(metrics: ControllerMeasurementState): boolean {
    const request = host.getPendingRequest();
    const geometry = getPaintedNativeTailGeometry({ input, request, metrics });
    if (!geometry || !request) {
      if (host.getPendingVerification()?.paintedGeometry) host.cancelPendingAttempt();
      landing = null;
      return false;
    }
    const previous = landing;
    const unchanged =
      previous !== null &&
      previous.requestId === request.id &&
      samePaintedNativeGeometry(previous.geometry, geometry);
    if (unchanged) {
      if (!host.getPendingVerification() && input.isNearBottom()) {
        settle();
      } else {
        block();
      }
      return true;
    }
    host.cancelPendingAttempt();
    landing = { requestId: request.id, geometry };
    if (input.isNearBottom()) {
      settle();
      return true;
    }
    const attempt: AttemptContext = {
      requestId: request.id,
      retries: 0,
      paintedGeometry: geometry,
      startedContentHeight: metrics.contentHeight,
      startedOffsetY: metrics.offsetY,
      startedViewportHeight: metrics.viewportHeight,
    };
    host.setPendingVerification(attempt);
    input.scrollToBottom(false);
    host.scheduleVerification(attempt);
    block();
    return true;
  }

  return {
    /** Forget the current landing; a new request or route starts from nothing. */
    reset() {
      landing = null;
    },
    verify,
    tryLand,
  };
}
