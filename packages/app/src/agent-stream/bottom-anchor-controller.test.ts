import { describe, expect, it } from "vitest";
import {
  __private__,
  deriveBottomAnchorBlockedReason,
  type BottomAnchorMode,
  type BottomAnchorRouteRequest,
  type PaintedNativeTailBinding,
  type PaintedNativeTailEvidence,
  type BottomAnchorUserScroll,
} from "./bottom-anchor-controller";
import type { BottomAnchorTransportBehavior } from "./strategy";
import {
  createNativeViewportLifetime,
  createNativeViewportMetrics,
  type NativeViewportRefEffects,
  type NativeViewportLifetime,
  type NativeViewportRefOwner,
} from "./native-actual-row-model";

type MeasurementState = ReturnType<typeof createMeasurementState>;

function createMeasurementState(
  overrides?: Partial<{
    containerKey: string;
    viewportWidth: number;
    viewportHeight: number;
    contentHeight: number;
    offsetY: number;
    viewportMeasuredForKey: string | null;
    contentMeasuredForKey: string | null;
  }>,
) {
  return {
    containerKey: "scroll-view",
    viewportWidth: 0,
    viewportHeight: 0,
    contentHeight: 0,
    offsetY: 0,
    viewportMeasuredForKey: null,
    contentMeasuredForKey: null,
    ...overrides,
  };
}

function createPendingRequest() {
  return {
    id: 1,
    agentId: "agent-1",
    reason: "initial-entry" as const,
    requestKey: "route:agent-1",
  };
}

function createFrameScheduler() {
  let sequence = 0;
  const tasks = new Map<
    number,
    {
      cancelled: boolean;
      remainingFrames: number;
      callback: () => void;
      kind: "attempt" | "verification";
    }
  >();

  return {
    schedule(params: {
      kind: "attempt" | "verification";
      callback: () => void;
      delayFrames?: number;
    }) {
      const id = ++sequence;
      tasks.set(id, {
        cancelled: false,
        remainingFrames: Math.max(0, params.delayFrames ?? 0),
        callback: params.callback,
        kind: params.kind,
      });
      return id;
    },
    cancel(handle: unknown) {
      const task = tasks.get(handle as number);
      if (task) {
        task.cancelled = true;
      }
    },
    flushFrame() {
      const due: Array<() => void> = [];
      for (const [id, task] of Array.from(tasks.entries())) {
        if (task.cancelled) {
          tasks.delete(id);
          continue;
        }
        if (task.remainingFrames > 0) {
          task.remainingFrames -= 1;
          continue;
        }
        tasks.delete(id);
        due.push(task.callback);
      }
      for (const callback of due) {
        callback();
      }
    },
    flushAll(limit = 20) {
      for (let index = 0; index < limit && tasks.size > 0; index += 1) {
        this.flushFrame();
      }
    },
  };
}

/** A measured native row is independent from the driver's command and readiness state. */
function createPaintedNativeTailFixture(
  reason: BottomAnchorRouteRequest["reason"] = "initial-entry",
) {
  const request: BottomAnchorRouteRequest = {
    agentId: "agent-1",
    reason,
    requestKey: "route:agent-1:painted-cache",
  };
  const binding: PaintedNativeTailBinding = {
    agentId: request.agentId,
    requestKey: request.requestKey,
    containerKey: "native-virtualized",
    items: [{ id: "cached-user" }, { id: "cached-answer" }],
    scopeIdentity: {},
    viewportIdentity: {},
  };
  const evidence: PaintedNativeTailEvidence = {
    current: binding,
    row: { binding, id: "cached-user", index: 0, height: 240, mounted: true },
  };
  const measurementState = createMeasurementState({
    containerKey: binding.containerKey,
    viewportWidth: 390,
    viewportHeight: 600,
    contentHeight: 1800,
    offsetY: 0,
    viewportMeasuredForKey: binding.containerKey,
    contentMeasuredForKey: binding.containerKey,
  });
  return { request, evidence, measurementState };
}

type PaintedNativeTailFixture = ReturnType<typeof createPaintedNativeTailFixture>;

function replacePaintedRowBinding(
  fixture: PaintedNativeTailFixture,
  changes: Partial<PaintedNativeTailBinding>,
) {
  fixture.evidence.row.binding = { ...fixture.evidence.current, ...changes };
}

interface InvalidPaintedNativeTailFixture {
  label: string;
  change: (fixture: PaintedNativeTailFixture) => void;
}

const invalidPaintedNativeTailFixtures: InvalidPaintedNativeTailFixture[] = [
  {
    label: "unmounted row",
    change: ({ evidence }) => {
      evidence.row.mounted = false;
    },
  },
  {
    label: "zero-height row",
    change: ({ evidence }) => {
      evidence.row.height = 0;
    },
  },
  {
    label: "nonfinite row height",
    change: ({ evidence }) => {
      evidence.row.height = Number.POSITIVE_INFINITY;
    },
  },
  {
    label: "wrong index",
    change: ({ evidence }) => {
      evidence.row.index = 1;
    },
  },
  {
    label: "wrong row identity",
    change: ({ evidence }) => {
      evidence.row.id = "removed-user";
    },
  },
  {
    label: "old agent",
    change: (fixture) => replacePaintedRowBinding(fixture, { agentId: "agent-old" }),
  },
  {
    label: "old request",
    change: (fixture) => replacePaintedRowBinding(fixture, { requestKey: "route:old" }),
  },
  {
    label: "old container",
    change: (fixture) => replacePaintedRowBinding(fixture, { containerKey: "old-native" }),
  },
  {
    label: "equal IDs in another items snapshot",
    change: (fixture) =>
      replacePaintedRowBinding(fixture, { items: fixture.evidence.current.items.slice() }),
  },
  {
    label: "old scope",
    change: (fixture) => replacePaintedRowBinding(fixture, { scopeIdentity: {} }),
  },
  {
    label: "old viewport",
    change: (fixture) => replacePaintedRowBinding(fixture, { viewportIdentity: {} }),
  },
  {
    label: "unmeasured viewport",
    change: ({ measurementState }) => {
      measurementState.viewportMeasuredForKey = null;
    },
  },
  {
    label: "unmeasured content",
    change: ({ measurementState }) => {
      measurementState.contentMeasuredForKey = null;
    },
  },
  {
    label: "zero viewport width",
    change: ({ measurementState }) => {
      measurementState.viewportWidth = 0;
    },
  },
  {
    label: "empty current rows",
    change: ({ evidence }) => {
      evidence.current.items = [];
    },
  },
];

function createDriverHarness(input?: {
  transportBehavior?: BottomAnchorTransportBehavior;
  isNearBottom?: boolean;
  measurementState?: MeasurementState;
  authoritativeReady?: boolean;
  paintedNativeTailEvidence?: PaintedNativeTailEvidence;
  getMeasurementState?: () => MeasurementState;
}) {
  const scheduler = createFrameScheduler();
  const measurementState =
    input?.measurementState ??
    createMeasurementState({
      viewportWidth: 800,
      viewportHeight: 480,
      contentHeight: 1200,
      viewportMeasuredForKey: "scroll-view",
      contentMeasuredForKey: "scroll-view",
    });
  const context = {
    agentId: "agent-1",
    authoritativeReady: input?.authoritativeReady ?? true,
    paintedNativeTailEvidence: input?.paintedNativeTailEvidence ?? null,
    renderStrategy: "forward-stream",
    transportBehavior: input?.transportBehavior ?? {
      verificationDelayFrames: 0,
      verificationRetryMode: "rescroll",
    },
    measurementState,
    nearBottom: input?.isNearBottom ?? true,
  };
  const scrollAttempts: boolean[] = [];
  let scrollToBottomBehavior = () => {
    context.nearBottom = true;
    context.measurementState.offsetY = 720;
  };
  const scrollToBottom = (animated: boolean) => {
    scrollAttempts.push(animated);
    scrollToBottomBehavior();
  };
  const modeChanges: BottomAnchorMode[] = [];
  // Optional evidence leaves the existing web/local harness behavior unchanged.
  const paintedNativeInput = {
    getPaintedNativeTailEvidence: () => context.paintedNativeTailEvidence,
  };
  const driver = __private__.createBottomAnchorControllerDriver({
    ...paintedNativeInput,
    getAgentId: () => context.agentId,
    getIsAuthoritativeHistoryReady: () => context.authoritativeReady,
    getRenderStrategy: () => context.renderStrategy,
    getTransportBehavior: () => context.transportBehavior,
    getMeasurementState: input?.getMeasurementState ?? (() => context.measurementState),
    isNearBottom: () => context.nearBottom,
    scrollToBottom,
    onModeChange: (mode) => {
      modeChanges.push(mode);
    },
    scheduleFrame: (params) => scheduler.schedule(params),
    cancelFrame: (handle) => scheduler.cancel(handle),
  });

  return {
    context,
    driver,
    scheduler,
    scrollAttempts,
    setScrollToBottomBehavior(next: () => void) {
      scrollToBottomBehavior = next;
    },
    modeChanges,
  };
}

/** Exercise native ref ownership through the same measurement reader and driver
 * used by production. Only native mutations and accepted event values are supplied.
 */
function createViewportRefLifecycleFixture() {
  const fixture = createPaintedNativeTailFixture();
  const origin = createNativeViewportLifetime<object>();
  const viewport = fixture.evidence.current.viewportIdentity;
  const currentLifetime: { current: NativeViewportLifetime | null } = { current: null };
  let heldViewport: object | null = null;
  let publishedViewport: object | null = null;
  let measurements = createNativeViewportMetrics();
  let gestureOrigin: NativeViewportLifetime | null = null;
  let gestureRetirements = 0;
  let measurementResets = 0;
  let readInvalidations = 0;
  const gestures = new Map<NativeViewportLifetime, BottomAnchorUserScroll>();
  const paintedRows = new Map<string, PaintedNativeTailEvidence>();
  function readMeasurements() {
    const current = currentLifetime.current;
    if (!current) return createNativeViewportMetrics();
    return current.readMeasurements({ current, held: heldViewport, measurements });
  }
  const harness = createDriverHarness({
    authoritativeReady: false,
    isNearBottom: false,
    getMeasurementState: readMeasurements,
  });
  harness.context.renderStrategy = "chronological-native-stream";
  harness.setScrollToBottomBehavior(() => {});
  const effects: NativeViewportRefEffects<object> = {
    lastAttachment: { current: null },
    currentLifetime,
    getHeldViewport: () => heldViewport,
    getGestureOrigin: () => gestureOrigin,
    setAnimatedRef: (next) => {
      if (next) heldViewport = next;
    },
    setViewportIdentity: (next) => {
      publishedViewport = next;
    },
    resetMeasurements: () => {
      measurementResets += 1;
      measurements = createNativeViewportMetrics();
    },
    invalidatePendingReads: () => {
      readInvalidations += 1;
    },
    clearPaintedRows: () => paintedRows.clear(),
    retireGesture: (departing) => {
      const gesture = gestures.get(departing);
      if (!gesture) return;
      gestures.delete(departing);
      if (gestureOrigin === departing) gestureOrigin = null;
      gestureRetirements += 1;
      gesture.retire();
    },
  };

  return {
    origin,
    viewport,
    effects,
    harness,
    attach(owner: NativeViewportRefOwner<object>, view: object) {
      const cleanup = owner.bindRef(view, effects);
      if (!cleanup) throw new Error("Native test attachment must be accepted");
      return cleanup;
    },
    acceptMeasurements() {
      if (!publishedViewport) throw new Error("Native measurements need a published viewport");
      measurements = { ...fixture.measurementState, offsetY: 200 };
      const binding = {
        ...fixture.evidence.current,
        viewportIdentity: publishedViewport,
        requestKey:
          harness.driver.getSnapshot().pendingRequest?.requestKey ?? fixture.request.requestKey,
      };
      const evidence = {
        current: binding,
        row: { ...fixture.evidence.row, binding },
      };
      harness.context.paintedNativeTailEvidence = evidence;
      paintedRows.set("cached-user", evidence);
    },
    beginGesture(owner: NativeViewportLifetime) {
      gestureOrigin = owner;
      const gesture = harness.driver.beginUserScroll();
      gestures.set(owner, gesture);
      return gesture;
    },
    readMeasurements,
    getRetainedContentHeight: () => measurements.contentHeight,
    getPaintedRowCount: () => paintedRows.size,
    getGestureRetirements: () => gestureRetirements,
    getMeasurementResets: () => measurementResets,
    getReadInvalidations: () => readInvalidations,
    loseAnimatedRef() {
      heldViewport = null;
    },
    applyInitialRequest() {
      harness.driver.applyRouteRequest(fixture.request);
    },
  };
}

describe("deriveBottomAnchorBlockedReason", () => {
  it("keeps initial-entry pending until history is ready and geometry is measurable", () => {
    const pendingRequest = createPendingRequest();

    expect(
      deriveBottomAnchorBlockedReason({
        pendingRequest,
        isAuthoritativeHistoryReady: false,
        measurementState: createMeasurementState(),
        pendingVerificationRequestId: null,
      }),
    ).toBe("waiting_for_history_readiness");

    expect(
      deriveBottomAnchorBlockedReason({
        pendingRequest,
        isAuthoritativeHistoryReady: true,
        measurementState: createMeasurementState({
          viewportHeight: 480,
          viewportMeasuredForKey: "scroll-view",
        }),
        pendingVerificationRequestId: null,
      }),
    ).toBe("waiting_for_measurable_content");

    expect(
      deriveBottomAnchorBlockedReason({
        pendingRequest,
        isAuthoritativeHistoryReady: true,
        measurementState: createMeasurementState({
          viewportHeight: 480,
          contentHeight: 1200,
          viewportMeasuredForKey: "scroll-view",
          contentMeasuredForKey: "scroll-view",
        }),
        pendingVerificationRequestId: pendingRequest.id,
      }),
    ).toBe("waiting_for_post_layout_verification");
  });
});

describe("bottom anchor controller driver", () => {
  it("retains measured viewport and active gesture across same-instance ref cleanup and reattachment", () => {
    const fixture = createPaintedNativeTailFixture();
    const harness = createDriverHarness({
      authoritativeReady: false,
      isNearBottom: false,
      measurementState: createNativeViewportMetrics(),
    });
    harness.context.renderStrategy = "chronological-native-stream";
    harness.setScrollToBottomBehavior(() => {});
    const origin = createNativeViewportLifetime<object>();
    const viewport = fixture.evidence.current.viewportIdentity;
    const paintedRows = new Map<string, PaintedNativeTailEvidence>();
    let heldViewport: object | null = null;
    let publishedViewport: object | null = null;
    let gesture: BottomAnchorUserScroll | null = null;
    let gestureRetirements = 0;
    const effects: NativeViewportRefEffects<object> = {
      lastAttachment: { current: null },
      currentLifetime: { current: null },
      getHeldViewport: () => heldViewport,
      getGestureOrigin: () => (gesture ? origin : null),
      setAnimatedRef: (next) => {
        // Reanimated's installed ref retains .current when called with null.
        if (next) heldViewport = next;
      },
      setViewportIdentity: (next) => {
        publishedViewport = next;
      },
      resetMeasurements: () => {
        harness.context.measurementState = createNativeViewportMetrics();
      },
      invalidatePendingReads: () => {},
      clearPaintedRows: () => paintedRows.clear(),
      retireGesture: (departingOrigin) => {
        expect(departingOrigin).toBe(origin);
        if (!gesture) return;
        gestureRetirements += 1;
        gesture.retire();
        gesture = null;
      },
    };
    const cleanup = origin.bindRef(viewport, effects);
    if (!cleanup) throw new Error("Initial native attachment must return its cleanup");

    harness.driver.applyRouteRequest(fixture.request);
    // These are accepted native measurements before the wrapper cycles its ref.
    harness.context.measurementState = { ...fixture.measurementState, offsetY: 200 };
    harness.context.paintedNativeTailEvidence = fixture.evidence;
    paintedRows.set("cached-user", fixture.evidence);
    gesture = harness.driver.beginUserScroll();
    const pendingRequestId = harness.driver.getSnapshot().pendingRequest?.id;

    cleanup();
    expect(origin.isCurrent(effects.currentLifetime.current, heldViewport)).toBe(false);
    const reattachedCleanup = origin.bindRef(viewport, effects);
    if (!reattachedCleanup) throw new Error("Same-instance native reattachment must be accepted");

    // No native frame or content event is required merely because a ref changed.
    expect(harness.context.measurementState.contentHeight).toBe(1800);
    expect(harness.context.measurementState.viewportHeight).toBe(600);
    expect(harness.context.measurementState.offsetY).toBe(200);
    expect(harness.context.measurementState.viewportMeasuredForKey).toBe("native-virtualized");
    expect(harness.context.measurementState.contentMeasuredForKey).toBe("native-virtualized");
    expect(paintedRows.size).toBe(1);
    expect(gestureRetirements).toBe(0);
    expect(publishedViewport).toBe(viewport);
    expect(origin.isCurrent(effects.currentLifetime.current, heldViewport)).toBe(true);
    expect(harness.driver.getSnapshot().pendingRequest?.id).toBe(pendingRequestId);
    expect(harness.driver.getSnapshot().mode).toBe("sticky-bottom");
    expect(harness.scrollAttempts.length).toBe(0);
    harness.driver.destroy();
  });

  it.each(["ref-first", "effect-first"] as const)(
    "native viewport ref lifecycle invalidates owner departure once with %s cleanup",
    (order) => {
      const f = createViewportRefLifecycleFixture();
      const cleanupRef = f.attach(f.origin, f.viewport);
      const deactivate = f.origin.activate(f.effects);
      f.applyInitialRequest();
      f.acceptMeasurements();
      f.beginGesture(f.origin);
      const readInvalidations = f.getReadInvalidations();

      if (order === "ref-first") cleanupRef();
      deactivate();
      cleanupRef();
      deactivate();

      expect(f.readMeasurements().contentHeight).toBe(0);
      expect(f.readMeasurements().viewportMeasuredForKey).toBeNull();
      expect(f.getRetainedContentHeight()).toBe(1800);
      expect(f.getGestureRetirements()).toBe(1);
      expect(f.getReadInvalidations()).toBe(readInvalidations + 1);
      expect(f.harness.driver.getSnapshot().mode).toBe("detached");
      expect(f.harness.driver.getSnapshot().pendingRequest).toBeNull();
      expect(f.harness.scrollAttempts.length).toBe(0);
      f.harness.driver.destroy();
    },
  );

  it("native viewport ref lifecycle reactivates a retained instance without a new measurement event", () => {
    const f = createViewportRefLifecycleFixture();
    const cleanupRef = f.attach(f.origin, f.viewport);
    const deactivate = f.origin.activate(f.effects);
    f.applyInitialRequest();
    f.acceptMeasurements();
    f.beginGesture(f.origin);
    const resets = f.getMeasurementResets();
    const readInvalidations = f.getReadInvalidations();

    deactivate();
    cleanupRef();
    f.attach(f.origin, f.viewport);
    f.loseAnimatedRef();
    expect(f.readMeasurements().contentHeight).toBe(0);
    expect(f.getRetainedContentHeight()).toBe(1800);
    f.origin.activate(f.effects);

    expect(f.readMeasurements().contentHeight).toBe(1800);
    expect(f.readMeasurements().viewportHeight).toBe(600);
    expect(f.readMeasurements().offsetY).toBe(200);
    expect(f.readMeasurements().viewportMeasuredForKey).toBe("native-virtualized");
    expect(f.readMeasurements().contentMeasuredForKey).toBe("native-virtualized");
    expect(f.getPaintedRowCount()).toBe(1);
    expect(f.getMeasurementResets()).toBe(resets);
    expect(f.getReadInvalidations()).toBe(readInvalidations + 1);
    expect(f.getGestureRetirements()).toBe(1);
    expect(f.harness.driver.getSnapshot().mode).toBe("detached");
    expect(f.harness.scrollAttempts.length).toBe(0);
    f.harness.driver.destroy();
  });

  it("native viewport ref lifecycle preserves ref-only intent when the animated current was cleared", () => {
    const f = createViewportRefLifecycleFixture();
    f.attach(f.origin, f.viewport);
    f.origin.activate(f.effects);
    f.applyInitialRequest();
    f.acceptMeasurements();
    f.beginGesture(f.origin);
    const pending = f.harness.driver.getSnapshot().pendingRequest?.id;

    f.origin.bindRef(null, f.effects);
    f.loseAnimatedRef();
    expect(f.readMeasurements().contentHeight).toBe(0);
    f.attach(f.origin, f.viewport);

    expect(f.readMeasurements().contentHeight).toBe(1800);
    expect(f.readMeasurements().offsetY).toBe(200);
    expect(f.getGestureRetirements()).toBe(0);
    expect(f.harness.driver.getSnapshot().pendingRequest?.id).toBe(pending);
    expect(f.harness.driver.getSnapshot().mode).toBe("sticky-bottom");
    expect(f.harness.scrollAttempts.length).toBe(0);
    f.harness.driver.destroy();
  });

  it("native viewport ref lifecycle rejects an old attachment cleanup after same-instance reattachment", () => {
    const f = createViewportRefLifecycleFixture();
    const staleCleanup = f.attach(f.origin, f.viewport);
    f.origin.activate(f.effects);
    f.applyInitialRequest();
    f.acceptMeasurements();
    f.beginGesture(f.origin);
    const currentCleanup = f.attach(f.origin, f.viewport);

    staleCleanup();
    expect(f.readMeasurements().contentHeight).toBe(1800);
    expect(f.getGestureRetirements()).toBe(0);
    currentCleanup();
    expect(f.readMeasurements().contentHeight).toBe(0);
    expect(f.getRetainedContentHeight()).toBe(1800);
    expect(f.getGestureRetirements()).toBe(0);
    f.harness.driver.destroy();
  });

  it.each(["different-instance", "same-instance"] as const)(
    "native viewport ref lifecycle resets replacement ownership with %s and rejects the old owner",
    (replacement) => {
      const f = createViewportRefLifecycleFixture();
      const staleCleanup = f.attach(f.origin, f.viewport);
      const staleDeactivate = f.origin.activate(f.effects);
      f.applyInitialRequest();
      f.acceptMeasurements();
      f.beginGesture(f.origin);
      const resets = f.getMeasurementResets();
      const readInvalidations = f.getReadInvalidations();

      const nextOwner = createNativeViewportLifetime<object>();
      const nextViewport = replacement === "same-instance" ? f.viewport : {};
      f.attach(nextOwner, nextViewport);
      nextOwner.activate(f.effects);
      expect(f.readMeasurements().contentHeight).toBe(0);
      expect(f.readMeasurements().offsetY).toBe(0);
      expect(f.getPaintedRowCount()).toBe(0);
      expect(f.getGestureRetirements()).toBe(1);
      expect(f.getMeasurementResets()).toBe(resets + 1);
      expect(f.getReadInvalidations()).toBe(readInvalidations + 1);

      const request = {
        agentId: "agent-1",
        reason: "resume",
        requestKey: "route:replacement-owner",
      } satisfies BottomAnchorRouteRequest;
      f.harness.driver.applyRouteRequest(request);
      f.acceptMeasurements();
      f.beginGesture(nextOwner);
      const pending = f.harness.driver.getSnapshot().pendingRequest?.id;
      staleCleanup();
      staleDeactivate();
      f.origin.bindRef(f.viewport, f.effects);
      f.origin.activate(f.effects);

      expect(f.effects.currentLifetime.current).toBe(nextOwner);
      expect(f.readMeasurements().contentHeight).toBe(1800);
      expect(f.harness.driver.getSnapshot().pendingRequest?.id).toBe(pending);
      expect(f.harness.driver.getSnapshot().pendingRequest?.requestKey).toBe(request.requestKey);
      expect(f.harness.driver.getSnapshot().mode).toBe("sticky-bottom");
      expect(f.getGestureRetirements()).toBe(1);
      expect(f.getMeasurementResets()).toBe(resets + 1);
      expect(f.getReadInvalidations()).toBe(readInvalidations + 1);
      expect(f.harness.scrollAttempts.length).toBe(0);
      f.harness.driver.destroy();
    },
  );

  it("native viewport ref lifecycle ignores an obsolete effect cleanup after reactivation and a new route", () => {
    const f = createViewportRefLifecycleFixture();
    f.attach(f.origin, f.viewport);
    const staleDeactivate = f.origin.activate(f.effects);
    f.applyInitialRequest();
    f.acceptMeasurements();
    f.beginGesture(f.origin);
    staleDeactivate();
    const deactivateCurrent = f.origin.activate(f.effects);
    const request = {
      agentId: "agent-1",
      reason: "resume",
      requestKey: "route:reactivated-owner",
    } satisfies BottomAnchorRouteRequest;
    f.beginGesture(f.origin);
    f.harness.driver.applyRouteRequest(request);
    const pending = f.harness.driver.getSnapshot().pendingRequest?.id;

    staleDeactivate();
    expect(f.readMeasurements().contentHeight).toBe(1800);
    expect(f.harness.driver.getSnapshot().pendingRequest?.id).toBe(pending);
    expect(f.getGestureRetirements()).toBe(1);
    expect(f.harness.scrollAttempts.length).toBe(0);
    deactivateCurrent();
    expect(f.readMeasurements().contentHeight).toBe(0);
    expect(f.getGestureRetirements()).toBe(2);
    expect(f.harness.driver.getSnapshot().pendingRequest?.requestKey).toBe(request.requestKey);
    f.harness.driver.destroy();
  });

  it("lands painted native cached content on resume while authoritative completion stays pending", () => {
    const request = {
      agentId: "agent-1",
      reason: "resume",
      requestKey: "route:agent-1:resume-painted-cache",
    } satisfies BottomAnchorRouteRequest;
    const binding: PaintedNativeTailBinding = {
      agentId: request.agentId,
      requestKey: request.requestKey,
      containerKey: "native-virtualized",
      items: [{ id: "cached-user" }, { id: "cached-answer" }],
      scopeIdentity: {},
      viewportIdentity: {},
    };
    const harness = createDriverHarness({
      authoritativeReady: false,
      isNearBottom: false,
      transportBehavior: {
        verificationDelayFrames: 2,
        verificationRetryMode: "recheck",
      },
      measurementState: createMeasurementState({
        containerKey: binding.containerKey,
        viewportWidth: 390,
        viewportHeight: 600,
        contentHeight: 1800,
        offsetY: 0,
        viewportMeasuredForKey: binding.containerKey,
        contentMeasuredForKey: binding.containerKey,
      }),
      paintedNativeTailEvidence: {
        current: binding,
        row: {
          binding,
          id: "cached-user",
          index: 0,
          height: 240,
          mounted: true,
        },
      },
    });
    harness.context.renderStrategy = "chronological-native-stream";
    const commands: { offset: number; animated: boolean }[] = [];
    harness.setScrollToBottomBehavior(() => {
      const metrics = harness.context.measurementState;
      commands.push({
        offset: Math.max(0, metrics.contentHeight - metrics.viewportHeight),
        animated: false,
      });
      // A command is not observed movement. Native metrics remain at zero
      // until the independent scroll observation below arrives.
    });

    harness.driver.applyRouteRequest(request);
    const pendingRequest = harness.driver.getSnapshot().pendingRequest;
    harness.scheduler.flushFrame();

    // The old history-blocked driver failed this first command expectation.
    expect(harness.scrollAttempts).toEqual([false]);
    expect(commands).toEqual([{ offset: 1200, animated: false }]);
    expect(harness.context.measurementState.offsetY).toBe(0);
    expect(pendingRequest).toEqual({ id: 1, ...request });

    // Fresh observed native movement certifies the physical landing only.
    harness.context.measurementState.offsetY = 1200;
    harness.context.nearBottom = true;
    harness.driver.handleScrollNearBottomChange({
      nextIsNearBottom: true,
      scrollDelta: 1200,
    });
    harness.scheduler.flushAll();
    expect(harness.driver.getSnapshot()).toEqual({
      mode: "sticky-bottom",
      pendingRequest,
      pendingVerification: null,
      blockedReason: "waiting_for_history_readiness",
    });
    expect(harness.context.authoritativeReady).toBe(false);
    expect(harness.scrollAttempts).toEqual([false]);

    // Authority can complete the same route request once its physical evidence
    // is current. It does not need another command for unchanged geometry.
    harness.context.authoritativeReady = true;
    harness.driver.notifyAuthoritativeHistoryMaybeChanged();
    harness.scheduler.flushAll();
    expect(harness.driver.getSnapshot()).toEqual({
      mode: "sticky-bottom",
      pendingRequest: null,
      pendingVerification: null,
      blockedReason: null,
    });
    expect(harness.scrollAttempts).toEqual([false]);
    harness.driver.destroy();
  });

  it.each(invalidPaintedNativeTailFixtures)(
    "rejects painted native evidence with $label",
    ({ change }) => {
      const fixture = createPaintedNativeTailFixture();
      change(fixture);
      const harness = createDriverHarness({
        authoritativeReady: false,
        isNearBottom: false,
        measurementState: fixture.measurementState,
        paintedNativeTailEvidence: fixture.evidence,
      });
      harness.context.renderStrategy = "chronological-native-stream";
      harness.driver.applyRouteRequest(fixture.request);
      harness.scheduler.flushAll();

      expect(harness.scrollAttempts.length).toBe(0);
      expect(harness.driver.getSnapshot().pendingRequest?.requestKey).toBe(
        fixture.request.requestKey,
      );
      expect(harness.driver.getSnapshot().blockedReason).toBe("waiting_for_history_readiness");
      harness.driver.destroy();
    },
  );

  it("keeps painted native spinner-only content blocked without a current row", () => {
    const fixture = createPaintedNativeTailFixture();
    const harness = createDriverHarness({
      authoritativeReady: false,
      isNearBottom: false,
      measurementState: fixture.measurementState,
    });
    harness.context.renderStrategy = "chronological-native-stream";
    harness.driver.applyRouteRequest(fixture.request);
    harness.scheduler.flushAll();

    expect(harness.scrollAttempts.length).toBe(0);
    expect(harness.driver.getSnapshot().blockedReason).toBe("waiting_for_history_readiness");
    harness.driver.destroy();
  });

  it("cancels painted native initial landing on manual reading and cannot rearm the same route", () => {
    const fixture = createPaintedNativeTailFixture();
    const harness = createDriverHarness({
      authoritativeReady: false,
      isNearBottom: false,
      measurementState: fixture.measurementState,
      paintedNativeTailEvidence: fixture.evidence,
    });
    harness.context.renderStrategy = "chronological-native-stream";
    harness.setScrollToBottomBehavior(() => {});
    harness.driver.applyRouteRequest(fixture.request);
    harness.scheduler.flushFrame();
    expect(harness.scrollAttempts).toEqual([false]);
    expect(harness.driver.getSnapshot().pendingVerification).not.toBeNull();

    harness.driver.beginUserScroll();
    harness.context.measurementState.offsetY = 100;
    harness.driver.endUserScroll({ isNearBottom: false });
    harness.context.authoritativeReady = true;
    harness.context.measurementState.contentHeight = 2400;
    harness.driver.handleContentSizeChange({ previousContentHeight: 1800, contentHeight: 2400 });
    harness.driver.notifyAuthoritativeHistoryMaybeChanged();
    harness.driver.notifyPaintedNativeTailMaybeChanged();
    harness.driver.applyRouteRequest(fixture.request);
    harness.scheduler.flushAll();

    expect(harness.scrollAttempts).toEqual([false]);
    expect(harness.context.measurementState.offsetY).toBe(100);
    expect(harness.driver.getSnapshot().mode).toBe("detached");
    expect(harness.driver.getSnapshot().pendingRequest).toBeNull();
    expect(harness.driver.getSnapshot().pendingVerification).toBeNull();
    harness.driver.destroy();
  });

  it("bounds painted native verification without treating commands as observed movement", () => {
    const fixture = createPaintedNativeTailFixture();
    const harness = createDriverHarness({
      authoritativeReady: false,
      isNearBottom: false,
      measurementState: fixture.measurementState,
      paintedNativeTailEvidence: fixture.evidence,
    });
    harness.context.renderStrategy = "chronological-native-stream";
    const targets: number[] = [];
    harness.setScrollToBottomBehavior(() => {
      const metrics = harness.context.measurementState;
      targets.push(metrics.contentHeight - metrics.viewportHeight);
    });
    harness.driver.applyRouteRequest(fixture.request);
    harness.scheduler.flushAll();
    const requestId = harness.driver.getSnapshot().pendingRequest?.id;
    expect(targets).toEqual([1200]);
    expect(harness.context.measurementState.offsetY).toBe(0);
    expect(harness.driver.getSnapshot().pendingVerification).toBeNull();

    harness.context.authoritativeReady = true;
    harness.driver.notifyAuthoritativeHistoryMaybeChanged();
    harness.driver.notifyPaintedNativeTailMaybeChanged();
    harness.driver.reevaluate();
    harness.scheduler.flushAll();
    expect(targets).toEqual([1200]);
    expect(harness.driver.getSnapshot().pendingRequest?.id).toBe(requestId);
    expect(harness.driver.getSnapshot().blockedReason).toBe("waiting_for_post_layout_verification");

    // A new physical target permits one new command, never another unchanged retry.
    harness.context.measurementState.contentHeight = 2000;
    harness.driver.handleContentSizeChange({ previousContentHeight: 1800, contentHeight: 2000 });
    harness.scheduler.flushAll();
    expect(targets).toEqual([1200, 1400]);
    expect(harness.driver.getSnapshot().pendingRequest?.id).toBe(requestId);
    harness.driver.notifyPaintedNativeTailMaybeChanged();
    harness.scheduler.flushAll();
    expect(targets.length).toBe(2);

    harness.context.measurementState.offsetY = 1400;
    harness.context.nearBottom = true;
    harness.driver.notifyPaintedNativeTailMaybeChanged();
    harness.scheduler.flushAll();
    expect(harness.driver.getSnapshot().pendingRequest).toBeNull();
    expect(harness.driver.getSnapshot().blockedReason).toBeNull();
    expect(targets.length).toBe(2);
    harness.driver.destroy();
  });

  it("rejects stale painted native row evidence when scope changes during verification", () => {
    const fixture = createPaintedNativeTailFixture();
    const harness = createDriverHarness({
      authoritativeReady: false,
      isNearBottom: false,
      measurementState: fixture.measurementState,
      paintedNativeTailEvidence: fixture.evidence,
    });
    harness.context.renderStrategy = "chronological-native-stream";
    harness.setScrollToBottomBehavior(() => {});
    harness.driver.applyRouteRequest(fixture.request);
    harness.scheduler.flushFrame();
    const requestId = harness.driver.getSnapshot().pendingRequest?.id;

    fixture.evidence.current = { ...fixture.evidence.current, scopeIdentity: {} };
    harness.context.measurementState.offsetY = 1200;
    harness.context.nearBottom = true;
    harness.scheduler.flushAll();
    expect(harness.driver.getSnapshot().pendingRequest?.id).toBe(requestId);
    expect(harness.driver.getSnapshot().pendingVerification).toBeNull();
    expect(harness.driver.getSnapshot().blockedReason).toBe("waiting_for_history_readiness");
    expect(harness.scrollAttempts).toEqual([false]);

    // Only a row rebound by the current scope can verify the provisional landing.
    fixture.evidence.row.binding = fixture.evidence.current;
    harness.driver.notifyPaintedNativeTailMaybeChanged();
    harness.scheduler.flushAll();
    expect(harness.driver.getSnapshot().pendingRequest?.id).toBe(requestId);
    harness.context.authoritativeReady = true;
    harness.driver.notifyAuthoritativeHistoryMaybeChanged();
    harness.scheduler.flushAll();
    expect(harness.driver.getSnapshot().pendingRequest).toBeNull();
    expect(harness.scrollAttempts).toEqual([false]);
    harness.driver.destroy();
  });

  it("retains painted native pending authority when a user ends scrolling at the bottom", () => {
    const fixture = createPaintedNativeTailFixture();
    const harness = createDriverHarness({
      authoritativeReady: false,
      isNearBottom: false,
      measurementState: fixture.measurementState,
      paintedNativeTailEvidence: fixture.evidence,
    });
    harness.context.renderStrategy = "chronological-native-stream";
    harness.setScrollToBottomBehavior(() => {});
    harness.driver.applyRouteRequest(fixture.request);
    harness.scheduler.flushFrame();
    const requestId = harness.driver.getSnapshot().pendingRequest?.id;
    harness.driver.beginUserScroll();
    harness.context.measurementState.offsetY = 1200;
    harness.context.nearBottom = true;
    harness.driver.endUserScroll({ isNearBottom: true });
    harness.scheduler.flushAll();

    expect(harness.scrollAttempts).toEqual([false]);
    expect(harness.driver.getSnapshot().pendingRequest?.id).toBe(requestId);
    expect(harness.driver.getSnapshot().blockedReason).toBe("waiting_for_history_readiness");
    harness.context.authoritativeReady = true;
    harness.driver.notifyAuthoritativeHistoryMaybeChanged();
    harness.scheduler.flushAll();
    expect(harness.driver.getSnapshot().pendingRequest).toBeNull();
    expect(harness.scrollAttempts).toEqual([false]);
    harness.driver.destroy();
  });

  it("does not let painted native row evidence bypass web history readiness", () => {
    const fixture = createPaintedNativeTailFixture();
    const harness = createDriverHarness({
      authoritativeReady: false,
      isNearBottom: false,
      measurementState: fixture.measurementState,
      paintedNativeTailEvidence: fixture.evidence,
    });
    harness.context.renderStrategy = "chronological-web-stream";
    harness.driver.applyRouteRequest(fixture.request);
    harness.scheduler.flushAll();
    expect(harness.scrollAttempts.length).toBe(0);
    expect(harness.driver.getSnapshot().blockedReason).toBe("waiting_for_history_readiness");
    harness.driver.destroy();
  });

  it.each(["jump-to-bottom", "message-sent", "rewind"] as const)(
    "does not use painted native evidence for local %s requests",
    (reason) => {
      const fixture = createPaintedNativeTailFixture();
      const harness = createDriverHarness({
        authoritativeReady: false,
        isNearBottom: false,
        measurementState: fixture.measurementState,
        paintedNativeTailEvidence: fixture.evidence,
      });
      harness.context.renderStrategy = "chronological-native-stream";
      harness.driver.requestLocalAnchor({ agentId: "agent-1", reason });
      harness.scheduler.flushAll();
      expect(harness.scrollAttempts.length).toBe(0);
      expect(harness.driver.getSnapshot().pendingRequest?.reason).toBe(reason);
      expect(harness.driver.getSnapshot().blockedReason).toBe("waiting_for_history_readiness");
      harness.driver.destroy();
    },
  );

  it("viewport gesture retirement releases departure without bottom success and permits a later route", () => {
    const fixture = createPaintedNativeTailFixture();
    const harness = createDriverHarness({
      authoritativeReady: false,
      isNearBottom: false,
      measurementState: fixture.measurementState,
      paintedNativeTailEvidence: fixture.evidence,
    });
    harness.context.renderStrategy = "chronological-native-stream";
    harness.setScrollToBottomBehavior(() => {});
    harness.driver.applyRouteRequest(fixture.request);
    const { retire } = harness.driver.beginUserScroll();
    retire();
    harness.driver.applyRouteRequest(fixture.request);
    harness.scheduler.flushAll();
    expect(harness.driver.getSnapshot().mode).toBe("detached");
    expect(harness.driver.getSnapshot().pendingRequest).toBeNull();
    expect(harness.context.measurementState.offsetY).toBe(0);
    expect(harness.scrollAttempts.length).toBe(0);

    const next = createPaintedNativeTailFixture("resume");
    next.request.requestKey = "route:replacement-viewport";
    next.evidence.current.requestKey = next.request.requestKey;
    harness.context.paintedNativeTailEvidence = next.evidence;
    harness.context.measurementState = next.measurementState;
    harness.driver.applyRouteRequest(next.request);
    retire();
    harness.scheduler.flushAll();
    expect(harness.scrollAttempts).toEqual([false]);
    expect(harness.driver.getSnapshot().pendingRequest?.requestKey).toBe(next.request.requestKey);
    expect(harness.driver.getSnapshot().blockedReason).toBe("waiting_for_history_readiness");
    harness.driver.destroy();
  });

  it.each(["release", "delayed-away", "delayed-bottom"] as const)(
    "viewport gesture retirement preserves a newer request on %s",
    (terminal) => {
      const fixture = createPaintedNativeTailFixture();
      const harness = createDriverHarness({
        authoritativeReady: false,
        isNearBottom: false,
        measurementState: fixture.measurementState,
        paintedNativeTailEvidence: fixture.evidence,
      });
      harness.context.renderStrategy = "chronological-native-stream";
      harness.setScrollToBottomBehavior(() => {});
      harness.driver.applyRouteRequest(fixture.request);
      const gesture = harness.driver.beginUserScroll();

      const next = createPaintedNativeTailFixture("resume");
      next.request.requestKey = "route:arrived-during-gesture";
      next.evidence.current.requestKey = next.request.requestKey;
      harness.context.paintedNativeTailEvidence = next.evidence;
      harness.driver.applyRouteRequest(next.request);
      const pendingId = harness.driver.getSnapshot().pendingRequest?.id;
      harness.scheduler.flushAll();
      expect(harness.scrollAttempts.length).toBe(0);

      if (terminal === "release") gesture.retire();
      else gesture.finish({ isNearBottom: terminal === "delayed-bottom" });
      harness.scheduler.flushAll();
      expect(harness.driver.getSnapshot().pendingRequest?.id).toBe(pendingId);
      expect(harness.driver.getSnapshot().mode).toBe("sticky-bottom");
      expect(harness.driver.getSnapshot().blockedReason).toBe("waiting_for_history_readiness");
      expect(harness.context.measurementState.offsetY).toBe(0);
      expect(harness.scrollAttempts).toEqual([false]);
      harness.driver.destroy();
    },
  );

  it("viewport gesture retirement from a previous agent cannot release the new agent's gesture", () => {
    const fixture = createPaintedNativeTailFixture();
    const harness = createDriverHarness({
      authoritativeReady: false,
      isNearBottom: false,
      measurementState: fixture.measurementState,
      paintedNativeTailEvidence: fixture.evidence,
    });
    harness.context.renderStrategy = "chronological-native-stream";
    harness.setScrollToBottomBehavior(() => {});
    harness.driver.applyRouteRequest(fixture.request);
    const { retire: oldRetire } = harness.driver.beginUserScroll();

    harness.context.agentId = "agent-2";
    harness.driver.resetForAgent();
    const next = createPaintedNativeTailFixture();
    next.request.agentId = "agent-2";
    next.request.requestKey = "route:agent-2:replacement";
    next.evidence.current.agentId = next.request.agentId;
    next.evidence.current.requestKey = next.request.requestKey;
    harness.context.paintedNativeTailEvidence = next.evidence;
    harness.driver.applyRouteRequest(next.request);
    const { retire: currentRetire } = harness.driver.beginUserScroll();
    oldRetire();
    harness.driver.notifyPaintedNativeTailMaybeChanged();
    harness.scheduler.flushAll();

    expect(harness.scrollAttempts.length).toBe(0);
    expect(harness.driver.getSnapshot().pendingRequest?.agentId).toBe("agent-2");
    expect(harness.driver.getSnapshot().mode).toBe("sticky-bottom");
    currentRetire();
    expect(harness.driver.getSnapshot().mode).toBe("detached");
    expect(harness.driver.getSnapshot().pendingRequest).toBeNull();
    harness.driver.destroy();
  });

  it("viewport gesture retirement cannot undo a completed observed bottom gesture", () => {
    const fixture = createPaintedNativeTailFixture();
    const harness = createDriverHarness({
      authoritativeReady: false,
      isNearBottom: false,
      measurementState: fixture.measurementState,
      paintedNativeTailEvidence: fixture.evidence,
    });
    harness.context.renderStrategy = "chronological-native-stream";
    harness.setScrollToBottomBehavior(() => {});
    harness.driver.applyRouteRequest(fixture.request);
    const gesture = harness.driver.beginUserScroll();
    harness.context.measurementState.offsetY = 1200;
    harness.context.nearBottom = true;
    gesture.finish({ isNearBottom: true });
    gesture.retire();
    harness.scheduler.flushAll();

    expect(harness.driver.getSnapshot().mode).toBe("sticky-bottom");
    expect(harness.driver.getSnapshot().pendingRequest?.requestKey).toBe(
      fixture.request.requestKey,
    );
    expect(harness.driver.getSnapshot().blockedReason).toBe("waiting_for_history_readiness");
    expect(harness.scrollAttempts.length).toBe(0);
    harness.context.authoritativeReady = true;
    harness.driver.notifyAuthoritativeHistoryMaybeChanged();
    harness.scheduler.flushAll();
    expect(harness.driver.getSnapshot().pendingRequest).toBeNull();
    expect(harness.driver.getSnapshot().mode).toBe("sticky-bottom");
    harness.driver.destroy();
  });

  it("keeps initial-entry pending until authoritative history and current geometry exist", () => {
    const harness = createDriverHarness({
      authoritativeReady: false,
      measurementState: createMeasurementState(),
    });

    harness.driver.applyRouteRequest({
      agentId: "agent-1",
      reason: "initial-entry",
      requestKey: "route:agent-1:initial-entry",
    });
    harness.scheduler.flushAll();

    expect(harness.scrollAttempts).toHaveLength(0);
    expect(harness.driver.getSnapshot()).toMatchObject({
      mode: "sticky-bottom",
      blockedReason: "waiting_for_history_readiness",
      pendingRequest: {
        reason: "initial-entry",
      },
    });

    harness.context.authoritativeReady = true;
    harness.context.measurementState.viewportHeight = 480;
    harness.context.measurementState.contentHeight = 1200;
    harness.context.measurementState.viewportMeasuredForKey = "scroll-view";
    harness.context.measurementState.contentMeasuredForKey = "scroll-view";
    harness.context.nearBottom = true;
    harness.driver.notifyAuthoritativeHistoryMaybeChanged();
    harness.driver.reevaluate();
    harness.scheduler.flushAll();

    expect(harness.scrollAttempts).toHaveLength(1);
    expect(harness.driver.getSnapshot()).toMatchObject({
      blockedReason: null,
      pendingRequest: null,
      pendingVerification: null,
    });
  });

  it("preserves a blocked route anchor while a user scroll ends at the bottom", () => {
    const harness = createDriverHarness({ authoritativeReady: false });

    harness.driver.applyRouteRequest({
      agentId: "agent-1",
      reason: "initial-entry",
      requestKey: "route:agent-1:initial-entry",
    });
    harness.scheduler.flushAll();

    harness.driver.beginUserScroll();
    harness.context.authoritativeReady = true;
    harness.driver.notifyAuthoritativeHistoryMaybeChanged();
    harness.driver.reevaluate();
    harness.scheduler.flushAll();

    expect(harness.scrollAttempts).toHaveLength(0);

    harness.driver.endUserScroll({ isNearBottom: true });
    harness.scheduler.flushAll();

    expect(harness.scrollAttempts).toHaveLength(1);
    expect(harness.driver.getSnapshot()).toMatchObject({
      mode: "sticky-bottom",
      blockedReason: null,
      pendingRequest: null,
      pendingVerification: null,
    });
  });

  it("preserves a blocked route anchor when layout moves after drag release", () => {
    const harness = createDriverHarness({ authoritativeReady: false });

    harness.driver.applyRouteRequest({
      agentId: "agent-1",
      reason: "resume",
      requestKey: "route:agent-1:resume",
    });
    harness.scheduler.flushAll();

    harness.driver.beginUserScroll();
    harness.context.nearBottom = false;
    harness.driver.handleScrollNearBottomChange({
      nextIsNearBottom: false,
      scrollDelta: 0,
    });
    harness.context.authoritativeReady = true;
    harness.driver.notifyAuthoritativeHistoryMaybeChanged();
    harness.driver.endUserScroll({ isNearBottom: true });
    harness.scheduler.flushAll();

    expect(harness.scrollAttempts).toHaveLength(1);
    expect(harness.driver.getSnapshot()).toMatchObject({
      mode: "sticky-bottom",
      blockedReason: null,
      pendingRequest: null,
      pendingVerification: null,
    });
  });

  it("lets a user scroll away supersede a blocked route anchor", () => {
    const harness = createDriverHarness({ authoritativeReady: false });

    harness.driver.applyRouteRequest({
      agentId: "agent-1",
      reason: "resume",
      requestKey: "route:agent-1:resume",
    });
    harness.scheduler.flushAll();

    harness.driver.beginUserScroll();
    harness.context.nearBottom = false;
    harness.driver.handleScrollNearBottomChange({
      nextIsNearBottom: false,
      scrollDelta: 48,
    });
    harness.driver.endUserScroll({ isNearBottom: false });
    harness.context.authoritativeReady = true;
    harness.driver.notifyAuthoritativeHistoryMaybeChanged();
    harness.driver.reevaluate();
    harness.scheduler.flushAll();

    expect(harness.scrollAttempts).toHaveLength(0);
    expect(harness.driver.getSnapshot()).toMatchObject({
      mode: "detached",
      blockedReason: null,
      pendingRequest: null,
      pendingVerification: null,
    });
  });

  it("suppresses sticky maintenance while detached", () => {
    const harness = createDriverHarness();

    harness.driver.detachByUser();
    harness.driver.handleContentSizeChange({
      previousContentHeight: 1200,
      contentHeight: 1500,
    });
    harness.driver.handleViewportMetricsChange({
      previousViewportWidth: 800,
      viewportWidth: 640,
      previousViewportHeight: 480,
      viewportHeight: 420,
    });
    harness.scheduler.flushAll();

    expect(harness.driver.getSnapshot().mode).toBe("detached");
    expect(harness.scrollAttempts).toHaveLength(0);
  });

  it("pauses sticky maintenance while a user scroll owns the viewport", () => {
    const harness = createDriverHarness({
      transportBehavior: {
        verificationDelayFrames: 2,
        verificationRetryMode: "recheck",
      },
    });

    harness.driver.prepareForStickyContentChange();
    harness.driver.beginUserScroll();
    harness.driver.handleContentSizeChange({
      previousContentHeight: 1200,
      contentHeight: 1400,
    });
    harness.context.nearBottom = false;
    harness.driver.handleScrollNearBottomChange({
      nextIsNearBottom: false,
      scrollDelta: 1,
    });
    harness.scheduler.flushAll();

    expect(harness.scrollAttempts).toHaveLength(1);
    expect(harness.driver.getSnapshot()).toMatchObject({
      mode: "sticky-bottom",
      pendingRequest: null,
      pendingVerification: null,
    });

    harness.driver.endUserScroll({ isNearBottom: false });

    expect(harness.driver.getSnapshot().mode).toBe("detached");
  });

  it("restores sticky maintenance when a user scroll returns to the bottom", () => {
    const harness = createDriverHarness({
      transportBehavior: {
        verificationDelayFrames: 2,
        verificationRetryMode: "recheck",
      },
    });

    harness.driver.beginUserScroll();
    harness.context.nearBottom = false;
    harness.driver.handleScrollNearBottomChange({
      nextIsNearBottom: false,
      scrollDelta: 48,
    });
    harness.driver.handleContentSizeChange({
      previousContentHeight: 1200,
      contentHeight: 1400,
    });
    harness.context.nearBottom = true;
    harness.driver.handleScrollNearBottomChange({
      nextIsNearBottom: true,
      scrollDelta: -48,
    });
    harness.driver.endUserScroll({ isNearBottom: true });
    harness.scheduler.flushAll();

    expect(harness.driver.getSnapshot()).toMatchObject({
      mode: "sticky-bottom",
      pendingRequest: null,
      pendingVerification: null,
    });
    expect(harness.scrollAttempts).toHaveLength(1);
  });

  it("switches back to sticky-bottom for explicit jump-to-bottom", () => {
    const harness = createDriverHarness({
      isNearBottom: false,
    });

    harness.driver.detachByUser();
    harness.driver.requestLocalAnchor({
      agentId: "agent-1",
      reason: "jump-to-bottom",
    });
    harness.scheduler.flushAll();

    expect(harness.modeChanges).toContain("detached");
    expect(harness.modeChanges).toContain("sticky-bottom");
    expect(harness.scrollAttempts).toHaveLength(1);
    expect(harness.driver.getSnapshot().mode).toBe("sticky-bottom");
  });

  it("schedules sticky maintenance on viewport and content growth", () => {
    const harness = createDriverHarness();

    harness.driver.handleViewportMetricsChange({
      previousViewportWidth: 800,
      viewportWidth: 640,
      previousViewportHeight: 480,
      viewportHeight: 420,
    });
    harness.scheduler.flushAll();

    harness.driver.handleContentSizeChange({
      previousContentHeight: 1200,
      contentHeight: 1600,
    });
    harness.scheduler.flushAll();

    expect(harness.scrollAttempts).toHaveLength(2);
  });

  it("keeps a pending request blocked when stale container measurements arrive", () => {
    const harness = createDriverHarness({
      measurementState: createMeasurementState({
        containerKey: "web-partial-virtualized",
        viewportHeight: 420,
        contentHeight: 1200,
        viewportMeasuredForKey: "scroll-view",
        contentMeasuredForKey: "scroll-view",
      }),
    });

    harness.driver.applyRouteRequest({
      agentId: "agent-1",
      reason: "resume",
      requestKey: "route:agent-1:resume",
    });
    harness.scheduler.flushAll();

    expect(harness.scrollAttempts).toHaveLength(0);
    expect(harness.driver.getSnapshot()).toMatchObject({
      blockedReason: "waiting_for_measurable_viewport",
      pendingRequest: {
        reason: "resume",
      },
    });

    harness.context.measurementState.viewportMeasuredForKey = "web-partial-virtualized";
    harness.context.measurementState.contentMeasuredForKey = "web-partial-virtualized";
    harness.driver.reevaluate();
    harness.scheduler.flushAll();

    expect(harness.scrollAttempts).toHaveLength(1);
    expect(harness.driver.getSnapshot().pendingRequest).toBeNull();
  });

  it("uses delayed rechecks instead of repeated rescroll loops for native transport", () => {
    const harness = createDriverHarness({
      transportBehavior: {
        verificationDelayFrames: 2,
        verificationRetryMode: "recheck",
      },
      isNearBottom: false,
    });
    harness.setScrollToBottomBehavior(() => {
      harness.context.measurementState.offsetY = 0;
    });

    harness.driver.requestLocalAnchor({
      agentId: "agent-1",
      reason: "jump-to-bottom",
    });

    harness.scheduler.flushFrame();
    expect(harness.scrollAttempts).toHaveLength(1);

    harness.scheduler.flushFrame();
    harness.scheduler.flushFrame();
    expect(harness.scrollAttempts).toHaveLength(1);

    harness.context.nearBottom = true;
    harness.scheduler.flushAll();

    expect(harness.scrollAttempts).toHaveLength(1);
    expect(harness.driver.getSnapshot().pendingRequest).toBeNull();
  });

  it("does not stay blocked on post-layout verification after a retry-scroll request", () => {
    const harness = createDriverHarness({
      measurementState: createMeasurementState({
        containerKey: "web-partial-virtualized",
        viewportWidth: 828,
        viewportHeight: 846,
        contentHeight: 14322,
        offsetY: 0,
        viewportMeasuredForKey: "web-partial-virtualized",
        contentMeasuredForKey: "web-partial-virtualized",
      }),
      isNearBottom: false,
    });

    harness.setScrollToBottomBehavior(() => {
      harness.context.measurementState.offsetY = 13476;
    });

    harness.driver.applyRouteRequest({
      agentId: "agent-1",
      reason: "resume",
      requestKey: "route:agent-1:resume",
    });

    harness.scheduler.flushFrame();
    expect(harness.scrollAttempts).toHaveLength(1);

    harness.context.measurementState.contentHeight = 14804;
    harness.context.nearBottom = false;
    harness.driver.handleContentSizeChange({
      previousContentHeight: 14322,
      contentHeight: 14804,
    });

    harness.scheduler.flushFrame();

    expect(harness.driver.getSnapshot()).toMatchObject({
      pendingRequest: {
        reason: "resume",
      },
      pendingVerification: {
        requestId: 1,
        retries: 1,
      },
    });

    harness.scheduler.flushFrame();

    expect(harness.scrollAttempts).toHaveLength(2);
    expect(harness.driver.getSnapshot()).toMatchObject({
      blockedReason: "waiting_for_post_layout_verification",
      pendingRequest: {
        reason: "resume",
      },
      pendingVerification: {
        requestId: 1,
      },
    });
  });

  it("does not fulfill a web partial-virtualized resume request before a confirmation pass", () => {
    const harness = createDriverHarness({
      measurementState: createMeasurementState({
        containerKey: "web-partial-virtualized",
        viewportWidth: 828,
        viewportHeight: 846,
        contentHeight: 14322,
        offsetY: 0,
        viewportMeasuredForKey: "web-partial-virtualized",
        contentMeasuredForKey: "web-partial-virtualized",
      }),
      isNearBottom: false,
    });

    harness.setScrollToBottomBehavior(() => {
      harness.context.measurementState.offsetY = Math.max(
        0,
        harness.context.measurementState.contentHeight -
          harness.context.measurementState.viewportHeight,
      );
      harness.context.nearBottom = true;
    });

    harness.driver.applyRouteRequest({
      agentId: "agent-1",
      reason: "resume",
      requestKey: "route:agent-1:resume-confirmation",
    });

    harness.scheduler.flushFrame();
    harness.scheduler.flushFrame();

    expect(harness.driver.getSnapshot()).toMatchObject({
      pendingRequest: {
        reason: "resume",
      },
      blockedReason: "waiting_for_post_layout_verification",
    });

    harness.context.measurementState.contentHeight = 16230;
    harness.context.nearBottom = false;
    harness.driver.handleContentSizeChange({
      previousContentHeight: 14322,
      contentHeight: 16230,
    });

    harness.scheduler.flushFrame();
    harness.scheduler.flushFrame();
    harness.scheduler.flushFrame();

    expect(harness.scrollAttempts).toHaveLength(2);
    expect(harness.driver.getSnapshot().pendingRequest).toMatchObject({
      reason: "resume",
    });
  });

  it("keeps sticky-bottom during viewport growth until bottom is re-verified", () => {
    const harness = createDriverHarness();
    harness.context.nearBottom = false;
    harness.setScrollToBottomBehavior(() => {
      harness.context.measurementState.offsetY = 720;
    });

    harness.driver.handleViewportMetricsChange({
      previousViewportWidth: 800,
      viewportWidth: 800,
      previousViewportHeight: 480,
      viewportHeight: 420,
    });
    harness.scheduler.flushAll();

    expect(harness.scrollAttempts).toHaveLength(4);
    expect(harness.driver.getSnapshot()).toMatchObject({
      mode: "sticky-bottom",
      pendingRequest: null,
      pendingVerification: null,
    });

    harness.driver.handleScrollNearBottomChange({
      nextIsNearBottom: false,
      scrollDelta: 0,
    });

    expect(harness.driver.getSnapshot().mode).toBe("sticky-bottom");

    harness.context.nearBottom = true;
    harness.driver.handleScrollNearBottomChange({
      nextIsNearBottom: true,
      scrollDelta: 0,
    });
    harness.scheduler.flushAll();
    harness.driver.handleScrollNearBottomChange({
      nextIsNearBottom: false,
      scrollDelta: 64,
    });

    expect(harness.driver.getSnapshot().mode).toBe("detached");
  });

  it("keeps sticky-bottom during streaming growth until bottom is re-verified", () => {
    const harness = createDriverHarness();
    harness.context.nearBottom = false;
    harness.setScrollToBottomBehavior(() => {
      harness.context.measurementState.offsetY = 900;
    });

    harness.driver.handleContentSizeChange({
      previousContentHeight: 1200,
      contentHeight: 1400,
    });
    harness.scheduler.flushAll();

    expect(harness.scrollAttempts).toHaveLength(4);
    expect(harness.driver.getSnapshot()).toMatchObject({
      mode: "sticky-bottom",
      pendingRequest: null,
      pendingVerification: null,
    });

    harness.driver.handleScrollNearBottomChange({
      nextIsNearBottom: false,
      scrollDelta: 0,
    });

    expect(harness.driver.getSnapshot().mode).toBe("sticky-bottom");

    harness.context.nearBottom = true;
    harness.driver.handleScrollNearBottomChange({
      nextIsNearBottom: true,
      scrollDelta: 0,
    });
    harness.scheduler.flushAll();
    harness.driver.handleScrollNearBottomChange({
      nextIsNearBottom: false,
      scrollDelta: 64,
    });

    expect(harness.driver.getSnapshot().mode).toBe("detached");
  });

  it("keeps initial native content growth anchored before layout scroll events arrive", () => {
    const harness = createDriverHarness({
      transportBehavior: {
        verificationDelayFrames: 2,
        verificationRetryMode: "recheck",
      },
      measurementState: createMeasurementState({
        containerKey: "native-virtualized",
        viewportWidth: 0,
        viewportHeight: 0,
        contentHeight: 0,
        offsetY: 0,
        viewportMeasuredForKey: null,
        contentMeasuredForKey: null,
      }),
    });
    harness.setScrollToBottomBehavior(() => {
      harness.context.measurementState.offsetY = 0;
    });

    harness.context.measurementState.contentHeight = 1348;
    harness.context.measurementState.contentMeasuredForKey = "native-virtualized";
    harness.driver.handleContentSizeChange({
      previousContentHeight: 0,
      contentHeight: 1348,
    });

    expect(harness.scrollAttempts).toHaveLength(1);
    expect(harness.driver.getSnapshot()).toMatchObject({
      mode: "sticky-bottom",
      pendingVerification: {
        requestId: null,
      },
    });

    harness.context.measurementState.viewportWidth = 390;
    harness.context.measurementState.viewportHeight = 546;
    harness.context.measurementState.viewportMeasuredForKey = "native-virtualized";
    harness.context.measurementState.offsetY = 50;
    harness.context.nearBottom = false;
    harness.driver.handleScrollNearBottomChange({
      nextIsNearBottom: false,
      scrollDelta: 50,
    });

    expect(harness.driver.getSnapshot().mode).toBe("sticky-bottom");
  });

  it("keeps native sticky content changes anchored when measured height is unchanged", () => {
    const harness = createDriverHarness({
      transportBehavior: {
        verificationDelayFrames: 2,
        verificationRetryMode: "recheck",
      },
      measurementState: createMeasurementState({
        containerKey: "native-virtualized",
        viewportWidth: 390,
        viewportHeight: 546,
        contentHeight: 546,
        offsetY: 0,
        viewportMeasuredForKey: "native-virtualized",
        contentMeasuredForKey: "native-virtualized",
      }),
    });
    harness.setScrollToBottomBehavior(() => {
      harness.context.measurementState.offsetY = 0;
      harness.context.nearBottom = true;
    });

    harness.driver.prepareForStickyContentChange();

    expect(harness.scrollAttempts).toHaveLength(1);
    expect(harness.driver.getSnapshot()).toMatchObject({
      mode: "sticky-bottom",
      pendingVerification: {
        requestId: null,
      },
    });

    harness.context.measurementState.offsetY = 50;
    harness.context.nearBottom = false;
    harness.driver.handleScrollNearBottomChange({
      nextIsNearBottom: false,
      scrollDelta: 50,
    });

    expect(harness.driver.getSnapshot().mode).toBe("sticky-bottom");
  });
});

describe("controller helper predicates", () => {
  it("rejects stale container measurements during post-scroll verification", () => {
    expect(
      __private__.deriveVerificationBlockedReason({
        isAuthoritativeHistoryReady: true,
        measurementState: createMeasurementState({
          containerKey: "web-partial-virtualized",
          viewportHeight: 420,
          contentHeight: 1200,
          viewportMeasuredForKey: "scroll-view",
          contentMeasuredForKey: "scroll-view",
        }),
      }),
    ).toBe("waiting_for_measurable_viewport");
  });

  it("allows verification only after authoritative readiness and current geometry exist", () => {
    expect(
      __private__.deriveVerificationBlockedReason({
        isAuthoritativeHistoryReady: false,
        measurementState: createMeasurementState({
          containerKey: "scroll-view",
          viewportHeight: 420,
          contentHeight: 1200,
          viewportMeasuredForKey: "scroll-view",
          contentMeasuredForKey: "scroll-view",
        }),
      }),
    ).toBe("waiting_for_history_readiness");

    expect(
      __private__.deriveVerificationBlockedReason({
        isAuthoritativeHistoryReady: true,
        measurementState: createMeasurementState({
          containerKey: "scroll-view",
          viewportHeight: 420,
          contentHeight: 1200,
          viewportMeasuredForKey: "scroll-view",
          contentMeasuredForKey: "scroll-view",
        }),
      }),
    ).toBeNull();
  });

  it("suppresses auto-anchor helpers while detached", () => {
    const mode: BottomAnchorMode = "detached";

    expect(
      __private__.shouldRestickOnContentChange({
        mode,
        previousContentHeight: 1000,
        contentHeight: 1100,
      }),
    ).toBe(false);
    expect(
      __private__.shouldRestickOnViewportChange({
        mode,
        previousViewportWidth: 800,
        viewportWidth: 640,
        previousViewportHeight: 400,
        viewportHeight: 360,
      }),
    ).toBe(false);
  });

  it("does not detach from sticky while a restick request is still pending", () => {
    expect(
      __private__.shouldDetachFromScrollAway({
        mode: "sticky-bottom",
        nextIsNearBottom: false,
        scrollDelta: 0,
        hasPendingRequest: true,
        hasPendingVerification: false,
        hasUnverifiedStickyMeasurementChange: false,
      }),
    ).toBe(false);

    expect(
      __private__.shouldDetachFromScrollAway({
        mode: "sticky-bottom",
        nextIsNearBottom: false,
        scrollDelta: 0,
        hasPendingRequest: false,
        hasPendingVerification: true,
        hasUnverifiedStickyMeasurementChange: false,
      }),
    ).toBe(false);

    expect(
      __private__.shouldDetachFromScrollAway({
        mode: "sticky-bottom",
        nextIsNearBottom: false,
        scrollDelta: 0,
        hasPendingRequest: false,
        hasPendingVerification: false,
        hasUnverifiedStickyMeasurementChange: true,
      }),
    ).toBe(false);

    expect(
      __private__.shouldDetachFromScrollAway({
        mode: "sticky-bottom",
        nextIsNearBottom: false,
        scrollDelta: 0,
        hasPendingRequest: false,
        hasPendingVerification: false,
        hasUnverifiedStickyMeasurementChange: false,
      }),
    ).toBe(true);
  });

  it("treats a large scroll delta as user detach even during an unverified sticky change", () => {
    expect(
      __private__.shouldDetachFromScrollAway({
        mode: "sticky-bottom",
        nextIsNearBottom: false,
        scrollDelta: 48,
        hasPendingRequest: false,
        hasPendingVerification: false,
        hasUnverifiedStickyMeasurementChange: true,
      }),
    ).toBe(true);
  });
});
