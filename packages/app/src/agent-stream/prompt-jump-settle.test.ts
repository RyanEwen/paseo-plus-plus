import { nativeTextPreviewMetrics } from "../components/ui/native-text-preview-metrics";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync, transformFromAstSync, traverse, types } from "@babel/core";
import {
  resolveMessageFlow,
  readMessageTextLayout,
  rebindMessageTextPrefix,
  prepareNativeMessagePresentation,
  bindNativeMessagePreparation,
  advanceNativeMessagePresentation,
  ordinaryNativeMessagePresentation,
  nativeMessageRoleVisible,
  acceptsNativeMessageDisclosure,
  nativeMessageViewportGeometry,
  projectNativePinnedMessage,
  type MessageFlowMeasurements,
} from "../components/prompt-message/flow-model";
import { resolveActualPromptPin } from "./actual-prompt-pin-model";

import { describe, expect, it, vi } from "vitest";
import {
  createPromptJumpSettleController,
  type PromptJumpSettleViewport,
} from "./prompt-jump-settle";

describe("native presentation reaction inputs", () => {
  const require = createRequire(import.meta.url);
  const reanimatedRoot = path.dirname(require.resolve("react-native-reanimated/package.json"));

  /** Select the actual production function, including its current lexical bindings. */
  function sourceFunction(filename: string, name: string) {
    const ast = parseSync(readFileSync(filename, "utf8"), {
      filename,
      babelrc: false,
      configFile: false,
      parserOpts: { plugins: ["typescript", "jsx"] },
    });
    if (!ast) throw new Error("Production source did not parse");
    const matches: types.FunctionDeclaration[] = [];
    traverse(ast, {
      FunctionDeclaration(selected) {
        if (selected.node.id?.name === name) matches.push(types.cloneNode(selected.node, true));
      },
    });
    const [declaration] = matches;
    if (!declaration || matches.length !== 1) throw new Error("Production function is not unique");
    return declaration;
  }

  /** Compile real source without importing the native UI. Supplied bindings only
   * capture registration or satisfy unexecuted native callback dependencies.
   */
  function bindSourceFunction(
    declaration: types.FunctionDeclaration,
    filename: string,
    bindings: Record<string, unknown>,
    worklets = false,
  ) {
    const result = transformFromAstSync(types.file(types.program([declaration])), undefined, {
      filename,
      babelrc: false,
      configFile: false,
      plugins: [
        [require.resolve("@babel/plugin-transform-typescript"), { isTSX: true }],
        ...(worklets ? [require.resolve("react-native-worklets/plugin")] : []),
      ],
    });
    if (!result?.code || !declaration.id)
      throw new Error("Production compiler emitted no function");
    const loaded: unknown = new Function(
      ...Object.keys(bindings),
      `${result.code}\nreturn ${declaration.id.name};`,
    )(...Object.values(bindings));
    if (typeof loaded !== "function") throw new Error("Production function did not bind");
    return (...args: unknown[]): unknown => Reflect.apply(loaded, undefined, args);
  }

  /** Preserve the real hook prefix and first reaction call. Returning its prepared
   * callback lets the installed Worklets compiler expose exactly what it captures.
   */
  function compiledPrepare(input: unknown) {
    const filename = fileURLToPath(
      new URL("../components/prompt-message/native-flow.tsx", import.meta.url),
    );
    const declaration = sourceFunction(filename, "useNativeMessageProjection");
    const statements = declaration.body.body;
    const index = statements.findIndex(
      (statement) =>
        types.isExpressionStatement(statement) &&
        types.isCallExpression(statement.expression) &&
        types.isIdentifier(statement.expression.callee, { name: "useAnimatedReaction" }),
    );
    const reaction = statements[index];
    if (!types.isExpressionStatement(reaction)) throw new Error("Production reaction is missing");
    declaration.body.body = [
      ...statements.slice(0, index),
      types.returnStatement(reaction.expression),
    ];
    const prepare = bindSourceFunction(
      declaration,
      filename,
      {
        useAnimatedReaction: (callback: unknown) => callback,
        advanceNativeMessagePresentation,
        scrollTo: undefined,
      },
      true,
    )(input);
    if (typeof prepare !== "function") throw new Error("Production preparation did not bind");
    const closure: unknown = Reflect.get(prepare, "__closure");
    if (!closure || typeof closure !== "object") throw new Error("Worklets closure is missing");
    return Object.values(closure);
  }

  /** Discover recursive SharedValue inputs using the installed Reanimated mapper. */
  function discoverReactionInputs(closure: unknown[]) {
    const markerFile = path.join(reanimatedRoot, "src/isSharedValue.ts");
    const isSharedValue = bindSourceFunction(
      sourceFunction(markerFile, "isSharedValue"),
      markerFile,
      {},
    );
    const mapperFile = path.join(reanimatedRoot, "src/mappers.ts");
    const discover = bindSourceFunction(sourceFunction(mapperFile, "extractInputs"), mapperFile, {
      isSharedValue,
    });
    const inputs = discover(closure, []);
    if (!Array.isArray(inputs)) throw new Error("Actual mapper did not return its input list");
    return inputs;
  }

  it.each([
    { kind: "line", prefix: 20, controls: 44, legacy: 76, compact: 52, top: 4, textY: -96 },
    { kind: "tall control", prefix: 20, controls: 60, legacy: 92, compact: 60, top: 0, textY: -92 },
    { kind: "large font", prefix: 56, controls: 44, legacy: 88, compact: 88, top: 22, textY: -96 },
  ])("fits Android compact $kind paint and controls without padding the control twice", (input) => {
    const measurements = {
      ...naturalMessageMeasurements(),
      prefixHeight: input.prefix,
      controls: { x: 0, y: 0, width: 64, height: input.controls },
    };
    const flow = resolveMessageFlow({ measurements, hasText: true });
    expect(flow?.compactHeight).toBe(input.legacy);
    const prepared = prepareNativeMessagePresentation({ measurements, flow, revision: 1 });
    if (!prepared) throw new Error("The measured compact body must prepare");
    const compact = projectNativePinnedMessage(
      { ...prepared, maximumHeight: 240 },
      { binding: 17, revision: 1, cycle: 1, mode: "compact" },
    );
    expect(compact).toMatchObject({
      mode: "compact",
      flowHeight: 340,
      bodyHeight: input.compact,
      visualHeight: input.compact + 40,
      controlsTop: input.top,
      textTranslateY: input.textY,
      prefixHeight: input.prefix,
    });
    expect(prepared.controlsTop + prepared.controlsHeight).toBeLessThanOrEqual(
      prepared.compactHeight,
    );
  });

  it("keeps Android painted clip offsets out of the natural body's width and origin", () => {
    const measurements = naturalMessageMeasurements();
    const input = { width: measurements.width, bubble: measurements.bubble };
    const fullRail = { clipLeft: 0, clipWidth: 320, bodyLeft: 0, bodyWidth: 320 };
    expect(nativeMessageViewportGeometry({ ...input, mode: "ordinary" })).toEqual(fullRail);
    expect(nativeMessageViewportGeometry({ ...input, mode: "compact" })).toEqual(fullRail);
    // The narrow expanded bubble is clipped at its actual x, while the opposite
    // ScrollView offset preserves the natural body's physical origin and width.
    expect(nativeMessageViewportGeometry({ ...input, mode: "expanded" })).toEqual({
      clipLeft: 60,
      clipWidth: 260,
      bodyLeft: -60,
      bodyWidth: 320,
    });
    expect(nativeMessageViewportGeometry({ ...input, mode: "ordinary" })).toEqual(fullRail);
    expect(nativeMessageViewportGeometry({ width: 0, bubble: null, mode: "ordinary" })).toEqual({
      clipLeft: 0,
      clipWidth: "100%",
      bodyLeft: 0,
      bodyWidth: "100%",
    });
  });

  it("rejects queued Android More after handoff retirement despite a stale compact frame", () => {
    const filename = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../components/prompt-message/native-flow.tsx",
    );
    const invoke = (callback: unknown, ...args: unknown[]) => {
      if (typeof callback !== "function") throw new Error("Disclosure callback is missing");
      return Reflect.apply(callback, undefined, args);
    };
    const request = bindSourceFunction(
      sourceFunction(filename, "requestNativeMessageDisclosure"),
      filename,
      { scheduleOnUI: invoke, scheduleOnRN: invoke, acceptsNativeMessageDisclosure },
      true,
    );
    const prepared = nativePresentationFixture();
    const compact = advanceNativeMessagePresentation({
      binding: 17,
      previous: ordinaryNativeMessagePresentation(),
      prepared,
      eligible: true,
      expanded: false,
      resetBody() {},
    });
    const changed = vi.fn();
    const driver = {
      binding: 17,
      activeBinding: { value: 17 },
      handoff: { value: false },
      presentation: { value: compact },
      expanded: { value: false },
      onExpandedChange: changed,
    };
    const command = {
      revision: compact.revision,
      cycle: compact.cycle,
      expected: "compact",
      expanded: true,
    };
    request(driver, command);
    expect(driver.expanded.value).toBe(false);
    expect(changed).not.toHaveBeenCalled();

    driver.handoff.value = true;
    request(driver, command);
    expect(driver.expanded.value).toBe(true);
    expect(changed).toHaveBeenCalledExactlyOnceWith(true);

    driver.expanded.value = false;
    driver.activeBinding.value = 18;
    request(driver, command);
    expect(driver.expanded.value).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("keeps the native presentation output out of the compiled prepare inputs", () => {
    // Input discovery only needs the real SharedValue marker, not a native runtime.
    const shared = (value: unknown) => ({ _isReanimatedSharedValue: true, value });
    const presentation = shared(ordinaryNativeMessagePresentation());
    const prepared = shared(null);
    const active = shared(true);
    const available = shared(true);
    const driver = {
      binding: 17,
      activeBinding: shared(17),
      handoff: shared(false),
      presentation,
      maximumHeight: shared(400),
      wrapperHeight: shared(500),
      expanded: shared(false),
    };
    const closure = compiledPrepare({
      driver,
      prepared,
      binding: { viewport: () => null, active, available },
    });
    const inputs = discoverReactionInputs(closure);
    const expected = [
      prepared,
      active,
      available,
      driver.activeBinding,
      driver.handoff,
      driver.maximumHeight,
      driver.wrapperHeight,
      driver.expanded,
    ];
    for (const dependency of expected) expect(inputs).toContain(dependency);
    expect(inputs).not.toContain(presentation);
    expect(new Set(inputs).size).toBe(expected.length);
  });
});

function naturalMessageMeasurements(): MessageFlowMeasurements {
  return {
    width: 320,
    bodyHeight: 300,
    trailingHeight: 40,
    bubble: { x: 60, y: 0, width: 260, height: 300 },
    content: { x: 16, y: 16, width: 228, height: 268 },
    text: { x: 0, y: 96, width: 228, height: 172 },
    prefixHeight: 20,
    controls: { x: 0, y: 0, width: 64, height: 44 },
  };
}

describe("native natural-flow sticky geometry", () => {
  it("recovers a changed natural line shape from current same-width frames without another Text event", () => {
    const binding = { key: {}, message: "full prompt", fontScale: 1, width: 228 };
    const original = readMessageTextLayout({
      binding,
      previous: null,
      bounded: true,
      lines: [{ y: 0, height: 20, width: 180 }],
    });
    expect(original.rebind).toBe(false);
    const changed = readMessageTextLayout({
      binding,
      previous: original.prefix,
      bounded: true,
      lines: [
        { y: 0, height: 56, width: 200 },
        { y: 60, height: 56, width: 200 },
        { y: 120, height: 52, width: 150 },
      ],
    });
    expect(changed.rebind).toBe(true);
    expect(changed.prefix.height).toBe(56);
    const replacement = { ...binding, key: {} };
    // From here on only current frames arrive. There is deliberately no second
    // readMessageTextLayout call to rescue the replacement binding.
    const rebound = rebindMessageTextPrefix({ prefix: changed.prefix, binding: replacement });
    const measurements = { ...naturalMessageMeasurements(), prefixHeight: null };
    expect(resolveMessageFlow({ measurements, hasText: true })).toBeNull();
    const recovered = resolveMessageFlow({
      measurements: { ...measurements, prefixHeight: rebound?.height ?? null },
      hasText: true,
    });
    expect(rebound?.key).toBe(replacement.key);
    expect(rebound?.width).toBe(228);
    expect(recovered?.flowHeight).toBe(340);
    expect(recovered?.compactHeight).toBe(88);
    expect(
      rebindMessageTextPrefix({ prefix: changed.prefix, binding: { ...replacement, width: 240 } }),
    ).toBeNull();
    expect(
      rebindMessageTextPrefix({ prefix: changed.prefix, binding: { ...replacement, width: null } }),
    ).toBeNull();
    expect(
      rebindMessageTextPrefix({
        prefix: changed.prefix,
        binding: { ...replacement, fontScale: 1.2 },
      }),
    ).toBeNull();
    expect(
      rebindMessageTextPrefix({
        prefix: changed.prefix,
        binding: { ...replacement, message: "another prompt" },
      }),
    ).toBeNull();
    const unmeasured = { ...changed.prefix, width: null };
    expect(rebindMessageTextPrefix({ prefix: unmeasured, binding: replacement })).toBeNull();
  });

  it("reserves the full ordinary bubble and action row while compact controls occupy only the visual extent", () => {
    const measurements = naturalMessageMeasurements();
    const compact = resolveMessageFlow({ measurements, hasText: true });
    expect(compact?.flowHeight).toBe(340);
    expect(compact?.compactHeight).toBe(76);
    expect(compact?.textClipWidth).toBe(224);
    expect(compact?.textWidth).toBe(228);
    expect(compact?.textTranslateY).toBe(-96);
    expect(compact?.textTranslateX).toBe(-60);

    const largerControls = resolveMessageFlow({
      measurements: { ...measurements, controls: { x: 0, y: 0, width: 80, height: 60 } },
      hasText: true,
    });
    expect(largerControls?.flowHeight).toBe(340);
    expect(largerControls?.compactHeight).toBe(92);
    expect(largerControls?.textClipWidth).toBe(208);
  });

  it("keeps ordinary fallback until a rebound width, text prefix and both complete body extents are measured", () => {
    const measurements = naturalMessageMeasurements();
    expect(
      resolveMessageFlow({ measurements: { ...measurements, width: 0 }, hasText: true }),
    ).toBeNull();
    expect(
      resolveMessageFlow({ measurements: { ...measurements, prefixHeight: null }, hasText: true }),
    ).toBeNull();
    expect(
      resolveMessageFlow({ measurements: { ...measurements, bodyHeight: null }, hasText: true }),
    ).toBeNull();
    expect(
      resolveMessageFlow({
        measurements: { ...measurements, trailingHeight: null },
        hasText: true,
      }),
    ).toBeNull();
    expect(
      resolveMessageFlow({ measurements: { ...measurements, controls: null }, hasText: true }),
    ).toBeNull();
    const fresh = resolveMessageFlow({
      measurements: {
        ...measurements,
        width: 280,
        bodyHeight: 380,
        bubble: { x: 0, y: 0, width: 280, height: 380 },
        content: { x: 16, y: 16, width: 248, height: 348 },
        text: { x: 0, y: 96, width: 248, height: 252 },
        prefixHeight: 30,
      },
      hasText: true,
    });
    expect(fresh?.flowHeight).toBe(420);
    expect(fresh?.textClipWidth).toBe(184);
  });

  it("retains attachment-only natural height without inventing a text line or waiting for a Text event", () => {
    const measurements = naturalMessageMeasurements();
    const flow = resolveMessageFlow({
      measurements: { ...measurements, text: null, prefixHeight: null, trailingHeight: 0 },
      hasText: false,
    });
    expect(flow?.flowHeight).toBe(300);
    expect(flow?.compactHeight).toBe(76);
    expect(flow?.textWidth).toBe(0);
    expect(flow?.textTranslateY).toBe(0);
  });
});

function nativePresentationFixture() {
  const measurements = naturalMessageMeasurements();
  const flow = resolveMessageFlow({ measurements, hasText: true });
  const prepared = prepareNativeMessagePresentation({ measurements, flow, revision: 1 });
  if (!prepared) throw new Error("The complete natural body fixture must prepare successfully");
  return { ...prepared, maximumHeight: 240 };
}

describe("Android full-exit native presentation", () => {
  it("Android full-exit effect replay preserves preparation and More offset until actual rebinding", () => {
    const key = {};
    const measurements = naturalMessageMeasurements();
    const flow = resolveMessageFlow({ measurements, hasText: true });
    const first = bindNativeMessagePreparation({
      key,
      measurements,
      flow,
      requiresControls: true,
      previous: null,
    });
    const replay = bindNativeMessagePreparation({
      key,
      measurements,
      flow,
      requiresControls: true,
      previous: first,
    });
    expect(replay.revision).toBe(first.revision);
    expect(replay.value?.revision).toBe(first.value?.revision);
    if (!first.value || !replay.value)
      throw new Error("Complete natural measurements must prepare");
    const prepared = { ...first.value, maximumHeight: 240 };
    const expanded = advanceNativeMessagePresentation({
      binding: 7,
      previous: ordinaryNativeMessagePresentation(),
      prepared,
      eligible: true,
      expanded: true,
      resetBody() {},
    });
    let resets = 0;
    const retained = advanceNativeMessagePresentation({
      binding: 7,
      previous: expanded,
      prepared: { ...replay.value, maximumHeight: 240 },
      eligible: true,
      expanded: true,
      resetBody() {
        resets += 1;
      },
    });
    expect(resets).toBe(0);
    expect(retained.mode).toBe("expanded");
    const rebound = bindNativeMessagePreparation({
      key: {},
      measurements,
      flow,
      requiresControls: true,
      previous: replay,
    });
    expect(rebound.revision > replay.revision).toBe(true);
  });

  it("Android full-exit restores ordinary paint only after the real More scroll reset", () => {
    const prepared = nativePresentationFixture();
    let resets = 0;
    let published = advanceNativeMessagePresentation({
      binding: 7,
      previous: ordinaryNativeMessagePresentation(),
      prepared,
      eligible: true,
      expanded: true,
      resetBody() {
        resets += 1;
      },
    });
    let innerOffset = 96;
    expect(published.mode).toBe("expanded");
    expect(published.visualHeight).toBe(240);
    expect(published.flowHeight).toBe(340);
    const restored = advanceNativeMessagePresentation({
      binding: 7,
      previous: published,
      prepared,
      eligible: false,
      expanded: true,
      resetBody() {
        expect(published.mode).toBe("expanded");
        innerOffset = 0;
        resets += 1;
      },
    });
    published = restored;
    expect(innerOffset).toBe(0);
    expect(resets).toBe(1);
    expect(published.mode).toBe("ordinary");
    expect(published.bodyHeight).toBe("auto");
    expect(published.flowHeight).toBe(340);
    expect(published.textTranslateY).toBe(0);
    expect(nativeMessageRoleVisible(published.mode, "body")).toBe(true);
    expect(nativeMessageRoleVisible(published.mode, "compact")).toBe(false);
    expect(nativeMessageRoleVisible(published.mode, "expanded")).toBe(false);
    expect(nativeMessageRoleVisible(published.mode, "pinned")).toBe(false);
  });

  it("Android full-exit Less resets the body before one-line paint and hides real attachment controls", () => {
    const prepared = nativePresentationFixture();
    const expanded = advanceNativeMessagePresentation({
      binding: 7,
      previous: ordinaryNativeMessagePresentation(),
      prepared,
      eligible: true,
      expanded: true,
      resetBody() {},
    });
    let reset = false;
    const compact = advanceNativeMessagePresentation({
      binding: 7,
      previous: expanded,
      prepared,
      eligible: true,
      expanded: false,
      resetBody() {
        reset = true;
      },
    });
    expect(reset).toBe(true);
    expect(compact.mode).toBe("compact");
    expect(compact.bodyHeight).toBe(52);
    expect(compact.visualHeight).toBe(92);
    expect(compact.flowHeight).toBe(340);
    expect(compact.textTranslateY).toBe(-96);
    expect(nativeMessageRoleVisible(compact.mode, "body")).toBe(false);
    expect(nativeMessageRoleVisible(compact.mode, "compact")).toBe(true);
    expect(nativeMessageRoleVisible(compact.mode, "expanded")).toBe(false);
  });

  it("Android full-exit unavailable or zero-cap preparation keeps full ordinary paint", () => {
    const missing = { ...naturalMessageMeasurements(), controls: null };
    const flow = resolveMessageFlow({ measurements: missing, hasText: true });
    expect(
      prepareNativeMessagePresentation({ measurements: missing, flow, revision: 2 }),
    ).toBeNull();
    for (const prepared of [null, { ...nativePresentationFixture(), maximumHeight: 0 }]) {
      const frame = advanceNativeMessagePresentation({
        binding: 7,
        previous: ordinaryNativeMessagePresentation(),
        prepared,
        eligible: true,
        expanded: false,
        resetBody() {
          throw new Error("An ordinary body must not reset");
        },
      });
      expect(frame.mode).toBe("ordinary");
      expect(frame.bodyHeight).toBe("auto");
      expect(frame.textClipWidth).toBe("auto");
      expect(nativeMessageRoleVisible(frame.mode, "body")).toBe(true);
      expect(nativeMessageRoleVisible(frame.mode, "pinned")).toBe(false);
    }
  });

  it("Android full-exit rebinding resets old More state before publishing a new ordinary owner", () => {
    const prepared = nativePresentationFixture();
    const old = advanceNativeMessagePresentation({
      binding: 7,
      previous: ordinaryNativeMessagePresentation(),
      prepared,
      eligible: true,
      expanded: true,
      resetBody() {},
    });
    let resets = 0;
    const replacement = advanceNativeMessagePresentation({
      binding: 8,
      previous: old,
      prepared: null,
      eligible: false,
      expanded: false,
      resetBody() {
        resets += 1;
      },
    });
    expect(resets).toBe(1);
    expect(replacement.binding).toBe(8);
    expect(replacement.mode).toBe("ordinary");
    expect(replacement.bodyHeight).toBe("auto");
    expect(replacement.cycle > old.cycle).toBe(true);
  });

  it("Android full-exit reset failure never publishes ordinary or a later allowed disposition", () => {
    const prepared = nativePresentationFixture();
    let published = advanceNativeMessagePresentation({
      binding: 7,
      previous: ordinaryNativeMessagePresentation(),
      prepared,
      eligible: true,
      expanded: true,
      resetBody() {},
    });
    const failure = new Error("held inner viewport reset failed");
    let caught: unknown;
    try {
      published = advanceNativeMessagePresentation({
        binding: 7,
        previous: published,
        prepared,
        eligible: false,
        expanded: false,
        resetBody() {
          throw failure;
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(published.mode).toBe("expanded");
  });

  it("Android full-exit rejects stale disclosure after reverse or a natural measurement revision", () => {
    const prepared = nativePresentationFixture();
    const old = advanceNativeMessagePresentation({
      binding: 7,
      previous: ordinaryNativeMessagePresentation(),
      prepared,
      eligible: true,
      expanded: false,
      resetBody() {},
    });
    expect(acceptsNativeMessageDisclosure(old, old.revision, old.cycle, "compact")).toBe(true);
    const ordinary = advanceNativeMessagePresentation({
      binding: 7,
      previous: old,
      prepared,
      eligible: false,
      expanded: false,
      resetBody() {},
    });
    expect(acceptsNativeMessageDisclosure(ordinary, old.revision, old.cycle, "compact")).toBe(
      false,
    );
    const reentered = advanceNativeMessagePresentation({
      binding: 7,
      previous: ordinary,
      prepared,
      eligible: true,
      expanded: false,
      resetBody() {},
    });
    expect(acceptsNativeMessageDisclosure(reentered, old.revision, old.cycle, "compact")).toBe(
      false,
    );
    const changed = advanceNativeMessagePresentation({
      binding: 7,
      previous: reentered,
      prepared: { ...prepared, revision: 2 },
      eligible: true,
      expanded: false,
      resetBody() {},
    });
    expect(acceptsNativeMessageDisclosure(changed, old.revision, changed.cycle, "compact")).toBe(
      false,
    );
  });
});

interface FakeFrameScheduler {
  requestFrame(callback: () => void): number;
  cancelFrame(frameId: number): void;
  runNextFrame(): void;
  pendingFrames(): number;
}

interface FakeViewport extends PromptJumpSettleViewport {
  estimateTargetTop(itemId: string): number | null;
  setEstimatedTargetTop(itemId: string, top: number): void;
  emitUserIntent(): void;
  setTargetTop(itemId: string, top: number | null): void;
  scrollWrites(): number[];
  requestedTargets(): string[];
}

function createFakeFrameScheduler(): FakeFrameScheduler {
  const frames = new Map<number, () => void>();
  let nextFrameId = 1;
  return {
    requestFrame(callback) {
      const frameId = nextFrameId;
      nextFrameId += 1;
      frames.set(frameId, callback);
      return frameId;
    },
    cancelFrame(frameId) {
      frames.delete(frameId);
    },
    runNextFrame() {
      const next = frames.entries().next().value;
      if (!next) {
        throw new Error("Expected a pending prompt jump frame");
      }
      const [frameId, callback] = next;
      frames.delete(frameId);
      callback();
    },
    pendingFrames() {
      return frames.size;
    },
  };
}

function createFakeViewport(input?: {
  clientHeight?: number;
  scrollHeight?: number;
  scrollTop?: number;
}): FakeViewport {
  const targets = new Map<string, number>();
  const estimates = new Map<string, number>();
  const requestedTargets: string[] = [];
  const scrollWrites: number[] = [];
  const userIntentListeners = new Set<() => void>();
  const clientHeight = input?.clientHeight ?? 100;
  const scrollHeight = input?.scrollHeight ?? 1_000;
  let scrollTop = input?.scrollTop ?? 100;
  return {
    findTargetTop(itemId) {
      requestedTargets.push(itemId);
      return targets.get(itemId) ?? null;
    },
    estimateTargetTop(itemId) {
      return estimates.get(itemId) ?? null;
    },
    setEstimatedTargetTop(itemId, top) {
      estimates.set(itemId, top);
    },
    getContainerTop() {
      return 0;
    },
    getScrollMetrics() {
      return { clientHeight, scrollHeight, scrollTop };
    },
    setScrollTop(nextScrollTop) {
      const previousScrollTop = scrollTop;
      const maxScrollTop = scrollHeight - clientHeight;
      scrollTop = Math.max(0, Math.min(nextScrollTop, maxScrollTop));
      const appliedDelta = scrollTop - previousScrollTop;
      for (const [itemId, top] of targets) {
        targets.set(itemId, top - appliedDelta);
      }
      for (const [itemId, top] of estimates) estimates.set(itemId, top - appliedDelta);
      scrollWrites.push(scrollTop);
    },
    subscribeToUserIntent(listener) {
      userIntentListeners.add(listener);
      return () => userIntentListeners.delete(listener);
    },
    emitUserIntent() {
      for (const listener of userIntentListeners) listener();
    },
    setTargetTop(itemId, top) {
      if (top === null) {
        targets.delete(itemId);
      } else {
        targets.set(itemId, top);
      }
    },
    scrollWrites() {
      return scrollWrites;
    },
    requestedTargets() {
      return requestedTargets;
    },
  };
}

function createController(viewport: FakeViewport, frames: FakeFrameScheduler) {
  return createPromptJumpSettleController({
    viewport,
    requestFrame: frames.requestFrame,
    cancelFrame: frames.cancelFrame,
  });
}

describe("prompt jump settle", () => {
  it("waits for a measured target when an unmounted estimate is already aligned", () => {
    const frames = createFakeFrameScheduler();
    const viewport = createFakeViewport();
    const controller = createController(viewport, frames);
    viewport.setEstimatedTargetTop("target", 8);

    controller.start("target");
    frames.runNextFrame();
    frames.runNextFrame();
    expect(controller.isActive()).toBe(true);

    // Mounting exposes the real row fifteen pixels below its virtual estimate.
    viewport.setTargetTop("target", 23);
    frames.runNextFrame();
    expect(viewport.scrollWrites()).toEqual([115]);
    expect(viewport.findTargetTop("target")).toBe(8);
    frames.runNextFrame();
    frames.runNextFrame();
    expect(controller.isActive()).toBe(false);
  });

  it("requires consecutive measured frames after a target temporarily unmounts", () => {
    const frames = createFakeFrameScheduler();
    const viewport = createFakeViewport();
    const controller = createController(viewport, frames);
    viewport.setTargetTop("target", 8);

    controller.start("target");
    frames.runNextFrame();
    viewport.setTargetTop("target", null);
    frames.runNextFrame();
    viewport.setTargetTop("target", 8);
    frames.runNextFrame();
    expect(controller.isActive()).toBe(true);
    frames.runNextFrame();
    expect(controller.isActive()).toBe(false);
  });

  it("scrolls toward an estimate without declaring a clamped unmounted target settled", () => {
    const frames = createFakeFrameScheduler();
    const viewport = createFakeViewport({ clientHeight: 100, scrollHeight: 220, scrollTop: 100 });
    const controller = createController(viewport, frames);
    viewport.setEstimatedTargetTop("target", 50);

    controller.start("target");
    frames.runNextFrame();
    expect(viewport.scrollWrites()).toEqual([120]);
    expect(controller.isActive()).toBe(true);
    viewport.setTargetTop("target", 30);
    frames.runNextFrame();
    expect(controller.isActive()).toBe(false);
  });

  it("keeps the same frame budget while only an estimate is available", () => {
    const frames = createFakeFrameScheduler();
    const viewport = createFakeViewport();
    const controller = createController(viewport, frames);
    viewport.setEstimatedTargetTop("target", 8);

    controller.start("target");
    for (let frame = 0; frame < 23; frame += 1) frames.runNextFrame();
    expect(controller.isActive()).toBe(true);
    frames.runNextFrame();
    expect(controller.isActive()).toBe(false);
    expect(frames.pendingFrames()).toBe(0);
  });

  it("cancels estimated navigation before a later measured target can scroll", () => {
    const frames = createFakeFrameScheduler();
    const viewport = createFakeViewport();
    const controller = createController(viewport, frames);
    viewport.setEstimatedTargetTop("target", 8);

    controller.start("target");
    frames.runNextFrame();
    viewport.emitUserIntent();
    viewport.setTargetTop("target", 23);
    expect(controller.isActive()).toBe(false);
    expect(frames.pendingFrames()).toBe(0);
    expect(viewport.scrollWrites()).toEqual([]);
  });

  it("re-pins the target when geometry shifts between frames", () => {
    const frames = createFakeFrameScheduler();
    const viewport = createFakeViewport();
    const controller = createController(viewport, frames);
    viewport.setTargetTop("target", 48);

    controller.start("target");
    frames.runNextFrame();
    viewport.setTargetTop("target", 28);
    frames.runNextFrame();

    expect(viewport.scrollWrites()).toEqual([140, 160]);
  });

  it("succeeds after two consecutive in-position frames", () => {
    const frames = createFakeFrameScheduler();
    const viewport = createFakeViewport();
    const controller = createController(viewport, frames);
    viewport.setTargetTop("target", 8);

    controller.start("target");
    frames.runNextFrame();
    frames.runNextFrame();

    expect(controller.isActive()).toBe(false);
  });

  it("succeeds when the target remains below the top at maximum scroll", () => {
    const frames = createFakeFrameScheduler();
    const viewport = createFakeViewport({ clientHeight: 100, scrollHeight: 220, scrollTop: 100 });
    const controller = createController(viewport, frames);
    viewport.setTargetTop("target", 50);

    controller.start("target");
    frames.runNextFrame();

    expect({ active: controller.isActive(), writes: viewport.scrollWrites() }).toEqual({
      active: false,
      writes: [120],
    });
  });

  it("aborts on user intent", () => {
    const frames = createFakeFrameScheduler();
    const viewport = createFakeViewport();
    const controller = createController(viewport, frames);

    controller.start("target");
    viewport.emitUserIntent();

    expect({ active: controller.isActive(), frames: frames.pendingFrames() }).toEqual({
      active: false,
      frames: 0,
    });
  });

  it("expires after its frame budget", () => {
    const frames = createFakeFrameScheduler();
    const viewport = createFakeViewport();
    const controller = createController(viewport, frames);

    controller.start("missing");
    for (let frame = 0; frame < 24; frame += 1) frames.runNextFrame();

    expect(controller.isActive()).toBe(false);
  });

  it("cancels the previous target when a newer jump starts", () => {
    const frames = createFakeFrameScheduler();
    const viewport = createFakeViewport();
    const controller = createController(viewport, frames);
    viewport.setTargetTop("new", 8);

    controller.start("old");
    controller.start("new");
    frames.runNextFrame();

    expect(viewport.requestedTargets()).toEqual(["new"]);
  });
});

it("smooth prompt scrolling produces intermediate positions and settles the measured target", () => {
  const frames = createFakeFrameScheduler();
  const viewport = createFakeViewport({ scrollHeight: 3000 });
  viewport.setTargetTop("prompt", 1000);
  let now = 0;
  const finished = vi.fn();
  const controller = createPromptJumpSettleController({
    viewport,
    requestFrame: frames.requestFrame,
    cancelFrame: frames.cancelFrame,
    now: () => now,
    onFinished: finished,
  });
  controller.start("prompt", { smooth: true });
  now = 60;
  frames.runNextFrame();
  const first = viewport.scrollWrites()[0]!;
  expect(first).toBeGreaterThan(100);
  expect(first).toBeLessThan(1092);
  now = 120;
  frames.runNextFrame();
  expect(viewport.scrollWrites()[1]).toBeGreaterThan(first);
  now = 240;
  frames.runNextFrame();
  while (frames.pendingFrames()) frames.runNextFrame();
  expect(viewport.findTargetTop("prompt")).toBeCloseTo(8);
  expect(finished).toHaveBeenCalledTimes(1);
});

it("manual intent cancels smooth scrolling without a stale frame moving the viewport", () => {
  const frames = createFakeFrameScheduler();
  const viewport = createFakeViewport();
  viewport.setTargetTop("prompt", 700);
  const controller = createPromptJumpSettleController({
    viewport,
    requestFrame: frames.requestFrame,
    cancelFrame: frames.cancelFrame,
    now: () => 0,
  });
  controller.start("prompt", { smooth: true });
  viewport.emitUserIntent();
  expect(frames.pendingFrames()).toBe(0);
  expect(viewport.scrollWrites()).toEqual([]);
});

it("native live prompt uses its measured landing offset and the animated path", () => {
  const f = nativeJumpFixture();
  f.setIndex(-1);
  f.setLiveOffset(5300);
  f.controller.start("live-prompt");
  expect(f.scrollToOffset).toHaveBeenCalledWith(5300, true);
  expect(f.scrollToIndex).not.toHaveBeenCalled();
  expect(f.onFailure).not.toHaveBeenCalled();
  f.setTargetTop(8);
  f.retry();
  f.retry();
  expect(f.controller.isActive()).toBe(false);
});

describe("explicit prompt jump placement", () => {
  it("pins a measured bubble beyond the edge, while the next original reveal retains its inset", () => {
    const frames = createFakeFrameScheduler();
    const viewport = createFakeViewport();
    const controller = createController(viewport, frames);
    viewport.setTargetTop("target", 50);
    controller.start("target", { placement: "pinned" });
    while (frames.pendingFrames()) frames.runNextFrame();
    expect(viewport.findTargetTop("target")).toBe(-2);
    controller.start("target", { placement: "original" });
    while (frames.pendingFrames()) frames.runNextFrame();
    expect(viewport.findTargetTop("target")).toBe(8);
  });

  it("does not finish pinned placement on an unmounted estimate and cancels its pending frames", () => {
    const frames = createFakeFrameScheduler();
    const viewport = createFakeViewport();
    const controller = createController(viewport, frames);
    viewport.setEstimatedTargetTop("target", -2);
    controller.start("target", { placement: "pinned" });
    frames.runNextFrame();
    frames.runNextFrame();
    expect(controller.isActive()).toBe(true);
    controller.cancel();
    expect(frames.pendingFrames()).toBe(0);
  });
});

describe("actual prompt row ownership", () => {
  it("hands off at the natural tail against fixed compact paint, independently of More", () => {
    const natural = [{ id: "prompt", top: 80, height: 340, compactHeight: 101, visualHeight: 101 }];
    const expanded = natural.map((row) => ({ ...row, visualHeight: 300 }));
    // Additive geometry is ignored by old source: the first guard is behavioral,
    // not a missing API/export or a manufactured renderer measurement.
    expect(resolveActualPromptPin(natural, 318)).toBeNull();
    const positions = [318, 319, 320, 319, 318];
    const expected = [null, "prompt", "prompt", "prompt", null];
    expect(positions.map((top) => resolveActualPromptPin(natural, top)?.id ?? null)).toEqual(
      expected,
    );
    expect(positions.map((top) => resolveActualPromptPin(expanded, top)?.id ?? null)).toEqual(
      expected,
    );
    const successor = [
      ...natural,
      { id: "next", top: 500, height: 340, compactHeight: 101, visualHeight: 101 },
    ];
    // Its ordinary original takes over the edge before its own later collapse.
    expect(resolveActualPromptPin(successor, 500)).toBeNull();
    expect(resolveActualPromptPin(successor, 739)?.id).toBe("next");
    const last = [{ id: "last", top: 80, height: 1000, compactHeight: 93 }];
    const maximumScroll = 80 + 1000 - 320;
    // No extra tail reservation may be invented to make a last USER reach987.
    expect(resolveActualPromptPin(last, maximumScroll)).toBeNull();
  });

  it("keeps one original row at the edge until its successor pushes it out", () => {
    const rows = [
      { id: "old", top: 80, height: 96 },
      { id: "new", top: 400, height: 96 },
    ];
    expect(resolveActualPromptPin(rows, 79)).toBeNull();
    expect(resolveActualPromptPin(rows, 80)).toEqual({ id: "old", translateY: 0 });
    expect(resolveActualPromptPin(rows, 200)).toEqual({ id: "old", translateY: 120 });
    for (const top of [305, 350, 399]) {
      const pin = resolveActualPromptPin(rows, top)!;
      expect(pin.id).toBe("old");
      // Same actual row: its trailing edge meets the incoming row exactly.
      expect(rows[0].top + pin.translateY + rows[0].height).toBe(rows[1].top);
    }
    expect(resolveActualPromptPin(rows, 400)).toEqual({ id: "new", translateY: 0 });
  });

  it("hands back the same row at the same position on reverse scrolling", () => {
    const rows = [{ id: "prompt", top: 80, height: 96 }];
    const positions = [79, 80, 81, 160, 81, 80, 79];
    expect(positions.map((top) => resolveActualPromptPin(rows, top))).toEqual([
      null,
      { id: "prompt", translateY: 0 },
      { id: "prompt", translateY: 1 },
      { id: "prompt", translateY: 80 },
      { id: "prompt", translateY: 1 },
      { id: "prompt", translateY: 0 },
      null,
    ]);
  });

  it("uses changed measured height for collision without adding a spacer", () => {
    const collapsed = [
      { id: "old", top: 80, height: 96 },
      { id: "new", top: 400, height: 96 },
    ];
    const expanded = [
      { id: "old", top: 80, height: 196 },
      { id: "new", top: 500, height: 96 },
    ];
    const oldPin = resolveActualPromptPin(collapsed, 350)!;
    const newPin = resolveActualPromptPin(expanded, 350)!;
    expect(oldPin.id).toBe(newPin.id);
    expect(80 + oldPin.translateY + 96).toBe(400);
    expect(80 + newPin.translateY + 196).toBe(500);
    expect(collapsed[0].top).toBe(expanded[0].top);
  });
});

describe("actual native preview line boundaries", () => {
  it("clips before an overlapping second line instead of exposing its first ink", () => {
    expect(
      nativeTextPreviewMetrics(
        [
          { y: 0, height: 23 },
          { y: 21, height: 23 },
        ],
        1,
      ),
    ).toEqual({ height: 21, count: 2 });
  });
  it("uses actual changed font/wrapping metrics and preserves full expanded line accounting", () => {
    const scaled = [
      { y: 2, height: 28 },
      { y: 31, height: 28 },
      { y: 60, height: 28 },
    ];
    expect(nativeTextPreviewMetrics(scaled, 1)).toEqual({ height: 30, count: 3 });
    expect(nativeTextPreviewMetrics(scaled, 2)).toEqual({ height: 59, count: 3 });
    expect(nativeTextPreviewMetrics([], 1)).toEqual({ height: 0, count: 0 });
  });
});
