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
  type MessageFlowMeasurements,
} from "../components/user-message-flow-model";
import {
  nativeBottomDistance,
  publishMeasuredNativeNearBottom,
  createNativeViewportLifetime,
  createNativeViewportMetrics,
  resolveActualNativeReading,
  resolveNativeMotionOwner,
  resolveNativeMeasurementOwner,
  nativeOriginalTop,
  nativeStickyTranslation,
  nativeStickyRowOwnsEdge,
  nativeStickySuccessorOwnsEdge,
  nativeStickyPresentationStyle,
  createNativeMeasuredHeaderIndex,
  isCurrentNativeReading,
  resolveNativeStickyHeights,
  nativeStickyVisualDelta,
  nativeFullRowStickyTranslation,
  nativeStickyInterpolation,
  type ActualNativeRowGeometry,
  type NativeStickyGeometry,
} from "./native-actual-row-model";
import { createNativeStickyLayout } from "./native-sticky-layout";
import { resolveActualPromptPin } from "./actual-prompt-pin-model";
import { resolvePromptHandoffProgress } from "./prompt-handoff";
import {
  createNativePromptHandoffPair,
  createNativePromptHandoffSampler,
  type NativePromptWindowRect,
} from "./native-prompt-handoff";
import type { StreamItem } from "@/types/stream";
import { createNativePromptJumpController } from "./native-prompt-jump";
import { describe, expect, it, vi } from "vitest";
import {
  createPromptJumpSettleController,
  type PromptJumpSettleViewport,
} from "./prompt-jump-settle";

type NativeBottomMeasurement = Parameters<typeof publishMeasuredNativeNearBottom>[0]["metrics"];

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
      new URL("../components/user-message-native-flow.tsx", import.meta.url),
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

  /** Evaluate the actual Android root style without importing native components.
   * Keep its hook call so the installed compiler applies the real worklet transform.
   */
  function compiledStickyValue(name: "style" | "handoff", bindings: Record<string, unknown>) {
    const filename = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "actual-sticky-header.android.tsx",
    );
    const declaration = sourceFunction(filename, "ActualStickyHeader");
    const style = declaration.body.body.find(
      (statement) =>
        types.isVariableDeclaration(statement) &&
        statement.declarations.some((entry) => types.isIdentifier(entry.id, { name })),
    );
    if (!style) throw new Error("Production sticky style is missing");
    const reader = types.functionDeclaration(
      types.identifier("readStickyStyle"),
      [],
      types.blockStatement([style, types.returnStatement(types.identifier(name))]),
    );
    const evaluate = bindSourceFunction(
      reader,
      filename,
      {
        ...bindings,
        useAnimatedStyle: (callback: unknown) => callback,
        useDerivedValue: (callback: unknown) => callback,
      },
      true,
    )();
    if (typeof evaluate !== "function") throw new Error("Production sticky style did not bind");
    return (): unknown => Reflect.apply(evaluate, undefined, []);
  }

  /** Capture the real discrete retirement reaction; scheduling is delivered to
   * its supplied RN sink directly, without claiming native queue or touch proof.
   */
  function compiledExpansionRetirement(input: unknown) {
    const filename = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "actual-sticky-header.android.tsx",
    );
    let prepare: unknown;
    let react: unknown;
    bindSourceFunction(
      sourceFunction(filename, "useNativeExpansionRetirement"),
      filename,
      {
        nativeStickySuccessorOwnsEdge,
        useAnimatedReaction: (read: unknown, reaction: unknown) => {
          prepare = read;
          react = reaction;
        },
        scheduleOnRN: (callback: unknown, value: boolean) => {
          if (typeof callback !== "function") throw new Error("Retirement sink is missing");
          Reflect.apply(callback, undefined, [value]);
        },
      },
      true,
    )(input);
    if (typeof prepare !== "function" || typeof react !== "function")
      throw new Error("Production retirement did not bind");
    const read = prepare;
    const reaction = react;
    const closure: unknown = Reflect.get(read, "__closure");
    if (!closure || typeof closure !== "object") throw new Error("Retirement closure is missing");
    return {
      captures: Object.values(closure),
      read: (): unknown => Reflect.apply(read, undefined, []),
      react: (value: unknown, previous: unknown): unknown =>
        Reflect.apply(reaction, undefined, [value, previous]),
    };
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
    const filename = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../components/user-message-flow-model.ts",
    );
    const project = bindSourceFunction(
      sourceFunction(filename, "projectNativePinnedMessage"),
      filename,
      {},
      true,
    );
    const compact = project(
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
    const filename = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../components/user-message-flow-model.ts",
    );
    const geometry = bindSourceFunction(
      sourceFunction(filename, "nativeMessageViewportGeometry"),
      filename,
      {},
      true,
    );
    const measurements = naturalMessageMeasurements();
    const input = { width: measurements.width, bubble: measurements.bubble };
    const fullRail = { clipLeft: 0, clipWidth: 320, bodyLeft: 0, bodyWidth: 320 };
    expect(geometry({ ...input, mode: "ordinary" })).toEqual(fullRail);
    expect(geometry({ ...input, mode: "compact" })).toEqual(fullRail);
    // The narrow expanded bubble is clipped at its actual x, while the opposite
    // ScrollView offset preserves the natural body's physical origin and width.
    expect(geometry({ ...input, mode: "expanded" })).toEqual({
      clipLeft: 60,
      clipWidth: 260,
      bodyLeft: -60,
      bodyWidth: 320,
    });
    expect(geometry({ ...input, mode: "ordinary" })).toEqual(fullRail);
    expect(geometry({ width: 0, bubble: null, mode: "ordinary" })).toEqual({
      clipLeft: 0,
      clipWidth: "100%",
      bodyLeft: 0,
      bodyWidth: "100%",
    });
  });

  it("keeps explicit Android attachment expansion above following content until successor takeover", () => {
    const measurements = {
      ...naturalMessageMeasurements(),
      bodyHeight: 80,
      bubble: { x: 60, y: 0, width: 260, height: 80 },
      content: { x: 16, y: 16, width: 228, height: 48 },
      text: null,
      prefixHeight: null,
    };
    const flow = resolveMessageFlow({ measurements, hasText: false });
    const natural = prepareNativeMessagePresentation({ measurements, flow, revision: 1 });
    if (!natural) throw new Error("Attachment-only preparation is missing");
    const prepared = { ...natural, maximumHeight: 400 };
    const expanded = advanceNativeMessagePresentation({
      binding: 17,
      previous: ordinaryNativeMessagePresentation(),
      prepared,
      eligible: true,
      expanded: true,
      resetBody() {},
    });
    const geometry = {
      value: { binding: 17, ready: true, y: 1000, flowHeight: prepared.flowHeight, next: 1600 },
    };
    const y = { value: 1332 };
    const presentation = { value: expanded };
    const readStyle = compiledStickyValue("style", {
      geometry,
      presentation,
      activeBinding: { value: 17 },
      binding: 17,
      enabled: true,
      handoff: { value: true },
      y,
      k: { value: 40 },
      topOverlayInset: 144,
      nativeStickyTranslation,
      nativeStickyPresentationStyle,
    });

    expect(expanded.bodyHeight).toBe(80);
    expect(expanded.flowHeight).toBe(120);
    // Only disclosure/actions fit before the next USER. More must not push the
    // actual image body behind the header just to preserve compact collision.
    expect(readStyle()).toMatchObject({ transform: [{ translateY: 516 }] });
    expect(readStyle()).toMatchObject({ zIndex: 20 });

    // A delayed presentation frame cannot keep covering the successor once its
    // natural top reaches the same measured reading edge.
    y.value = 1416;
    expect(readStyle()).toMatchObject({ transform: [{ translateY: 0 }] });
    expect(readStyle()).toMatchObject({ zIndex: 10 });
    y.value = 1417;
    expect(readStyle()).toMatchObject({ transform: [{ translateY: 0 }] });

    const reset = vi.fn();
    presentation.value = advanceNativeMessagePresentation({
      binding: 17,
      previous: expanded,
      prepared,
      eligible: false,
      expanded: true,
      resetBody: reset,
    });
    expect(reset).toHaveBeenCalledTimes(1);
    expect(nativeMessageRoleVisible(presentation.value.mode, "pinned")).toBe(false);

    y.value = 1332;
    presentation.value = advanceNativeMessagePresentation({
      binding: 17,
      previous: expanded,
      prepared,
      eligible: true,
      expanded: false,
      resetBody: reset,
    });
    expect(presentation.value.mode).toBe("compact");
    expect(readStyle()).toMatchObject({ transform: [{ translateY: 516 }] });
    expect(readStyle()).toMatchObject({ zIndex: 10 });

    y.value = 935;
    presentation.value = ordinaryNativeMessagePresentation();
    expect(readStyle()).toMatchObject({ transform: [{ translateY: 0 }] });
  });

  it("retires Android expansion at the successor edge without reopening it on reverse", () => {
    const value: NativeStickyGeometry = {
      binding: 17,
      ready: true,
      y: 1000,
      flowHeight: 340,
      next: 1800,
    };
    const geometry = { _isReanimatedSharedValue: true, value };
    const y = { _isReanimatedSharedValue: true, value: 1799 };
    const k = { _isReanimatedSharedValue: true, value: 0 };
    const readHandoff = compiledStickyValue("handoff", {
      geometry,
      binding: 17,
      enabled: true,
      y,
      k,
      topOverlayInset: 0,
      nativeStickyRowOwnsEdge,
    });
    const handoff = { value: true };
    const expanded = { _isReanimatedSharedValue: true, value: true };
    const activeBinding = { _isReanimatedSharedValue: true, value: 17 };
    const remember = vi.fn();
    const retirement = compiledExpansionRetirement({
      binding: 17,
      activeBinding,
      expanded,
      onExpandedChange: remember,
      geometry,
      y,
      k,
      topOverlayInset: 0,
    });
    const inputs = discoverReactionInputs(retirement.captures);
    for (const dependency of [geometry, y, k, activeBinding]) expect(inputs).toContain(dependency);
    expect(inputs).not.toContain(expanded);
    expect(readHandoff()).toBe(true);
    retirement.react(retirement.read(), null);
    expect(expanded.value).toBe(true);

    // Returning to this row's ordinary body resets its viewport elsewhere but
    // preserves the user's disclosure preference until a successor takes over.
    y.value = 1300;
    expect(readHandoff()).toBe(false);
    retirement.react(retirement.read(), null);
    expect(expanded.value).toBe(true);
    expect(remember).not.toHaveBeenCalled();

    y.value = 1800;
    expect(readHandoff()).toBe(false);
    handoff.value = false;
    retirement.react(retirement.read(), true);
    expect(expanded.value).toBe(false);
    expect(remember).toHaveBeenCalledExactlyOnceWith(false);
    y.value = 1801;
    expect(readHandoff()).toBe(false);

    const prepared = nativePresentationFixture();
    const old = advanceNativeMessagePresentation({
      binding: 17,
      previous: ordinaryNativeMessagePresentation(),
      prepared,
      eligible: true,
      expanded: true,
      resetBody() {},
    });
    const reset = vi.fn();
    const ordinary = advanceNativeMessagePresentation({
      binding: 17,
      previous: old,
      prepared,
      eligible: handoff.value,
      expanded: expanded.value,
      resetBody: reset,
    });
    expect(reset).toHaveBeenCalledTimes(1);
    expect(ordinary.mode).toBe("ordinary");
    expect(ordinary.flowHeight).toBe(340);
    expect(nativeMessageRoleVisible(ordinary.mode, "pinned")).toBe(false);

    y.value = 1799;
    expect(readHandoff()).toBe(true);
    handoff.value = true;
    retirement.react(retirement.read(), false);
    const returned = advanceNativeMessagePresentation({
      binding: 17,
      previous: ordinary,
      prepared,
      eligible: handoff.value,
      expanded: expanded.value,
      resetBody: reset,
    });
    expect(returned.mode).toBe("compact");
    expect(acceptsNativeMessageDisclosure(returned, old.revision, old.cycle, "expanded")).toBe(
      false,
    );
    expect(remember).toHaveBeenCalledTimes(1);

    // Unknown geometry does not establish takeover, including a remount with
    // remembered disclosure. Current geometry at the successor edge does.
    y.value = 1800;
    value.ready = false;
    handoff.value = false;
    expanded.value = true;
    retirement.react(retirement.read(), null);
    expect(expanded.value).toBe(true);
    expect(remember).toHaveBeenCalledTimes(1);
    value.ready = true;
    retirement.react(retirement.read(), null);
    expect(expanded.value).toBe(false);
    expect(remember).toHaveBeenCalledTimes(2);

    // A late reaction from a replaced row must not clear its successor's preference.
    activeBinding.value = 18;
    expanded.value = true;
    handoff.value = false;
    retirement.react(retirement.read(), true);
    expect(expanded.value).toBe(true);
    expect(remember).toHaveBeenCalledTimes(2);
  });

  it("rejects stale Android expanded roots and unready geometry without a raised overlay", () => {
    const prepared = nativePresentationFixture();
    const frame = advanceNativeMessagePresentation({
      binding: 17,
      previous: ordinaryNativeMessagePresentation(),
      prepared,
      eligible: true,
      expanded: true,
      resetBody() {},
    });
    const geometry = {
      value: { binding: 17, ready: true, y: 1000, flowHeight: 340, next: 1800 },
    };
    const activeBinding = { value: 17 };
    const presentation = { value: frame };
    const y = { value: 1500 };
    const bindings = {
      geometry,
      presentation,
      activeBinding,
      binding: 17,
      enabled: true,
      y,
      k: { value: 0 },
      topOverlayInset: 0,
      nativeStickyPresentationStyle,
    };
    const readStyle = compiledStickyValue("style", bindings);
    expect(readStyle()).toMatchObject({ transform: [{ translateY: 500 }], zIndex: 20 });
    activeBinding.value = 18;
    expect(readStyle()).toMatchObject({ transform: [{ translateY: 0 }], zIndex: 10 });
    activeBinding.value = 17;
    geometry.value.binding = 18;
    expect(readStyle()).toMatchObject({ transform: [{ translateY: 0 }], zIndex: 10 });
    geometry.value.binding = 17;
    presentation.value = { ...frame, binding: 18 };
    expect(readStyle()).toMatchObject({ transform: [{ translateY: 0 }], zIndex: 10 });
    presentation.value = frame;
    geometry.value.ready = false;
    expect(readStyle()).toMatchObject({ transform: [{ translateY: 0 }], zIndex: 10 });
    geometry.value.ready = true;
    y.value = 1300;
    expect(readStyle()).toMatchObject({ transform: [{ translateY: 0 }], zIndex: 10 });
    y.value = 1500;
    const disabledStyle = compiledStickyValue("style", { ...bindings, enabled: false });
    expect(disabledStyle()).toMatchObject({ transform: [{ translateY: 0 }], zIndex: 10 });
  });

  it("rejects queued Android More after handoff retirement despite a stale compact frame", () => {
    const filename = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../components/user-message-native-flow.tsx",
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
  it("delayed native prompt handoff keeps a partially visible ordinary row unpinned and naturally positioned", () => {
    const fixture = effectiveNativeReadingFixture();
    const geometry = new Map<string, ActualNativeRowGeometry>(fixture.geometry);
    geometry.set("old", { index: 0, y: 1000, height: 340, pinnedHeight: 80 });
    geometry.set("old-answer", { index: 1, y: 1340, height: 500 });
    geometry.set("later", { index: 2, y: 1840, height: 100 });
    geometry.set("later-answer", { index: 3, y: 1940, height: 300 });
    const input = {
      ...fixture,
      geometry,
      headers: createNativeMeasuredHeaderIndex({ items: fixture.items, geometry }),
      clippedLeading: 0,
      offset: 1000,
      viewportHeight: 300,
      handoff: "full-row" as const,
    };
    const atRowTop = resolveActualNativeReading(input);
    const insideOrdinaryBody = resolveActualNativeReading({ ...input, offset: 1100 });
    const motion = {
      offset: 1100,
      leadingInset: 0,
      layout: 1000,
      flowHeight: 340,
      pinnedHeight: 80,
      next: 1840,
      handoff: "full-row" as const,
    };
    const outerTranslation = nativeStickyTranslation(
      motion.offset,
      motion.layout,
      motion.flowHeight,
      motion.next,
    );
    const innerCorrection = nativeStickyVisualDelta(motion);
    const topTranslation = nativeStickyTranslation(
      input.offset,
      motion.layout,
      motion.flowHeight,
      motion.next,
    );
    const topCorrection = nativeStickyVisualDelta({ ...motion, offset: input.offset });

    // Delaying only JS disclosure would leave RN moving the full ordinary body.
    // Its bottom is still 240 below the reading edge, so cancel that movement.
    expect(outerTranslation + innerCorrection).toBe(0);
    expect(topTranslation + topCorrection).toBe(0);
    expect(atRowTop.pinnedId).toBeNull();
    expect(insideOrdinaryBody.pinnedId).toBeNull();
    expect(atRowTop.rowId).toBe("old");
    expect(insideOrdinaryBody.rowId).toBe("old");
    expect(geometry.get("old")?.height).toBe(340);
    expect(nativeOriginalTop(1340, 1100, 0, 0)).toBe(240);
  });

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

  it("includes outer ordinary spacing and the entire visible action row without changing the list's flow height", () => {
    const collapsed = resolveNativeStickyHeights({
      layoutHeight: 372,
      body: { flowHeight: 340, visualHeight: 116 },
    });
    const expanded = resolveNativeStickyHeights({
      layoutHeight: 372,
      body: { flowHeight: 340, visualHeight: 300 },
    });
    expect(collapsed?.flowHeight).toBe(372);
    expect(expanded?.flowHeight).toBe(372);
    expect(collapsed?.pinnedHeight).toBe(148);
    expect(expanded?.pinnedHeight).toBe(332);
    expect(
      resolveNativeStickyHeights({
        layoutHeight: 300,
        body: { flowHeight: 340, visualHeight: 116 },
      }),
    ).toBeNull();
    const fallback = resolveNativeStickyHeights({ layoutHeight: 372, body: null });
    expect(fallback?.pinnedHeight).toBe(372);
  });

  it("publishes visual changes and invalidations without replaying a VirtualizedList layout event", () => {
    const channel = createNativeStickyLayout<number>({ key: "prompt", index: 2 });
    const listLayout = vi.fn<(event: number) => void>();
    const visual = vi.fn<(body: { flowHeight: number; visualHeight: number } | null) => void>();
    channel.subscribe(listLayout);
    const stop = channel.subscribeBody(visual);
    channel.publish(372);
    channel.publishBody({ flowHeight: 340, visualHeight: 116 });
    channel.publishBody({ flowHeight: 340, visualHeight: 116 });
    expect(visual).toHaveBeenCalledTimes(1);
    channel.publishBody({ flowHeight: 340, visualHeight: 300 });
    channel.publishBody(null);
    expect(visual).toHaveBeenCalledTimes(3);
    expect(visual.mock.calls[0][0]?.visualHeight).toBe(116);
    expect(visual.mock.calls[1][0]?.visualHeight).toBe(300);
    expect(visual.mock.calls[2][0]).toBeNull();
    expect(listLayout).toHaveBeenCalledExactlyOnceWith(372);
    expect(channel.readBody()).toBeNull();
    stop();
    channel.publishBody({ flowHeight: 340, visualHeight: 116 });
    expect(visual).toHaveBeenCalledTimes(3);
    const rebound = createNativeStickyLayout<number>({ key: "prompt", index: 3 });
    expect(rebound.readBody()).toBeNull();
  });

  it("corrects Android's full-flow outer transform only by the actual pinned collision extent and inset", () => {
    const input = {
      offset: 500,
      leadingInset: 184,
      layout: 100,
      flowHeight: 372,
      pinnedHeight: 148,
      next: 800,
    };
    const original = nativeStickyTranslation(
      input.offset,
      input.layout,
      input.flowHeight,
      input.next,
    );
    const delta = nativeStickyVisualDelta(input);
    expect(original).toBe(328);
    expect(delta).toBe(224);
    expect(input.layout - input.offset - input.leadingInset + original + delta).toBe(-32);
    expect(
      input.layout - input.offset - input.leadingInset + original + delta + input.pinnedHeight,
    ).toBe(116);
    expect(
      nativeStickyVisualDelta({ ...input, leadingInset: 0, pinnedHeight: input.flowHeight }),
    ).toBe(0);
    expect(nativeStickyVisualDelta({ ...input, next: null })).toBe(184);
  });

  it("builds iOS collision ranges from the separate heights while preserving RN's unknown and overlapping successors", () => {
    const ordinary = nativeStickyInterpolation(100, 372, 800);
    const visible = nativeStickyInterpolation(100, 148, 800);
    expect(ordinary.inputRange.join(",")).toBe("-1,0,100,428,429");
    expect(ordinary.outputRange.join(",")).toBe("0,0,0,328,328");
    expect(visible.inputRange.join(",")).toBe("-1,0,100,652,653");
    expect(visible.outputRange.join(",")).toBe("0,0,0,552,552");
    expect(nativeStickyInterpolation(100, 148, null).inputRange.join(",")).toBe("-1,0,100,101");
    expect(nativeStickyInterpolation(100, 148, 200).outputRange.join(",")).toBe("0,0,0,1");
  });

  it("keeps the full original row intersection while sticky visibility uses the complete visual extent", () => {
    const fixture = effectiveNativeReadingFixture();
    const geometry = new Map<string, ActualNativeRowGeometry>(fixture.geometry);
    geometry.set("old", { index: 0, y: 1000, height: 340, pinnedHeight: 80 });
    geometry.set("old-answer", { index: 1, y: 1340, height: 500 });
    geometry.set("later", { index: 2, y: 1840, height: 0 });
    geometry.set("later-answer", { index: 3, y: 1840, height: 300 });
    fixture.mounted.delete("later");
    const input = {
      ...fixture,
      geometry,
      headers: createNativeMeasuredHeaderIndex({ items: fixture.items, geometry }),
      clippedLeading: 0,
      offset: 1280,
      viewportHeight: 300,
    };
    const original = resolveActualNativeReading(input);
    expect(original.rowId).toBe("old");
    expect(original.pinnedId).toBe("old");
    expect(input.headers.nextTop(0)).toBe(1840);

    const collision = resolveActualNativeReading({ ...input, offset: 1800 });
    expect(collision.rowId).toBe("old-answer");
    expect(collision.pinnedId).toBe("old");
    const passed = resolveActualNativeReading({ ...input, offset: 1840 });
    expect(passed.pinnedId).toBeNull();
    expect(passed.rowId).toBe("later-answer");
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
  it.each([
    { kind: "short", height: 40 },
    { kind: "tall", height: 340 },
    { kind: "attachment-only", height: 184 },
  ])("Android full-exit $kind row crosses only at its complete bottom", ({ height }) => {
    const input = {
      offset: 1000 + height - 1,
      leadingInset: 0,
      layout: 1000,
      flowHeight: height,
      pinnedHeight: 80,
      next: 1840,
    };
    expect(nativeFullRowStickyTranslation(input)).toBe(0);
    expect(nativeFullRowStickyTranslation({ ...input, offset: 1000 + height })).toBe(height);
    expect(nativeFullRowStickyTranslation({ ...input, offset: 1000 + height + 1 })).toBe(
      height + 1,
    );
    expect(nativeFullRowStickyTranslation({ ...input, offset: 1000 + height })).toBe(height);
    expect(nativeFullRowStickyTranslation(input)).toBe(0);
  });

  it("Android full-exit uses actual keyboard and header displacement at the same boundary", () => {
    const input = {
      offset: 1200,
      leadingInset: 140,
      layout: 1000,
      flowHeight: 340,
      pinnedHeight: 80,
      next: 1840,
    };
    expect(nativeFullRowStickyTranslation({ ...input, leadingInset: 139 })).toBe(0);
    expect(nativeFullRowStickyTranslation(input)).toBe(340);
    expect(nativeFullRowStickyTranslation({ ...input, leadingInset: 141 })).toBe(341);
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

  it("Android full-exit preserves zero-height unmounted successor collision without pinning that successor", () => {
    const fixture = effectiveNativeReadingFixture();
    const geometry = new Map(fixture.geometry);
    geometry.set("old", { index: 0, y: 1000, height: 340, pinnedHeight: 80 });
    geometry.set("later", { index: 2, y: 1400, height: 0 });
    const mounted = new Set(["old", "old-answer"]);
    const headers = createNativeMeasuredHeaderIndex({ items: fixture.items, geometry });
    expect(headers.nextTop(0)).toBe(1400);
    const input = {
      ...fixture,
      geometry,
      mounted,
      headers,
      handoff: "full-row" as const,
      offset: 1350,
      clippedLeading: 0,
    };
    expect(resolveActualNativeReading(input).pinnedId).toBe("old");
    expect(
      nativeFullRowStickyTranslation({
        offset: 1350,
        leadingInset: 0,
        layout: 1000,
        flowHeight: 340,
        pinnedHeight: 80,
        next: headers.nextTop(0),
      }),
    ).toBe(320);
    expect(resolveActualNativeReading({ ...input, offset: 1400 }).pinnedId).toBeNull();
  });

  it("Android full-exit opt-in preserves legacy iOS top-trigger and rejects unprepared Android pinning", () => {
    const fixture = effectiveNativeReadingFixture();
    const geometry = new Map(fixture.geometry);
    geometry.set("old", { index: 0, y: 1000, height: 340, pinnedHeight: 80, fullRowReady: false });
    // The enlarged original USER must not overlap a later, already eligible USER.
    geometry.set("old-answer", { index: 1, y: 1340, height: 150 });
    geometry.set("later", { index: 2, y: 1490, height: 53 });
    geometry.set("later-answer", { index: 3, y: 1543, height: 297 });
    const input = {
      ...fixture,
      geometry,
      headers: createNativeMeasuredHeaderIndex({ items: fixture.items, geometry }),
      offset: 1100,
      clippedLeading: 0,
    };
    expect(resolveActualNativeReading(input).pinnedId).toBe("old");
    expect(resolveActualNativeReading({ ...input, handoff: "full-row" }).pinnedId).toBeNull();
    expect(
      resolveActualNativeReading({ ...input, offset: 1340, handoff: "full-row" }).pinnedId,
    ).toBeNull();
  });
});

function createNativeBottomMeasurement(): NativeBottomMeasurement {
  return {
    containerKey: "native-virtualized",
    contentHeight: 0,
    viewportHeight: 0,
    offsetY: 0,
    viewportMeasuredForKey: null,
    contentMeasuredForKey: null,
  };
}

describe("native viewport lifetime", () => {
  it("rejects delayed callbacks from an old list instead of stamping the newly held list", () => {
    const oldOrigin = createNativeViewportLifetime();
    const oldViewport = {};
    expect(oldOrigin.attach(oldViewport)).toBe(true);
    expect(oldOrigin.isCurrent(oldOrigin, oldViewport)).toBe(true);

    const nextOrigin = createNativeViewportLifetime();
    const nextViewport = {};
    expect(oldOrigin.release(oldViewport)).toBe(true);
    expect(nextOrigin.attach(nextViewport)).toBe(true);

    // Event closures retain oldOrigin even when the owner now holds nextViewport.
    expect(oldOrigin.isCurrent(nextOrigin, nextViewport)).toBe(false);
    expect(nextOrigin.isCurrent(nextOrigin, nextViewport)).toBe(true);
    expect(nextOrigin.isCurrent(nextOrigin, oldViewport)).toBe(false);
  });

  it("requires the originating list component even if another owner holds the same object", () => {
    const viewport = {};
    const original = createNativeViewportLifetime();
    const replacement = createNativeViewportLifetime();
    expect(original.attach(viewport)).toBe(true);
    expect(replacement.attach(viewport)).toBe(true);
    expect(original.isCurrent(replacement, viewport)).toBe(false);
    expect(replacement.isCurrent(replacement, viewport)).toBe(true);
  });

  it("retires a detached origin without allowing it to acquire a different physical list", () => {
    const origin = createNativeViewportLifetime();
    const viewport = {};
    const other = {};
    expect(origin.attach(viewport)).toBe(true);
    expect(origin.release(other)).toBe(false);
    expect(origin.isCurrent(origin, viewport)).toBe(true);
    expect(origin.release(viewport)).toBe(true);
    expect(origin.isCurrent(origin, viewport)).toBe(false);
    expect(origin.attach(other)).toBe(false);
    expect(origin.isCurrent(origin, other)).toBe(false);

    // React may repeat a callback ref for the same physical instance.
    expect(origin.attach(viewport)).toBe(true);
    expect(origin.isCurrent(origin, viewport)).toBe(true);
  });

  it("clears the old observed bottom offset before a new viewport measures current content", () => {
    const previous = createNativeViewportMetrics();
    previous.contentHeight = 1800;
    previous.viewportHeight = 600;
    previous.offsetY = 1200;
    previous.viewportMeasuredForKey = previous.containerKey;
    previous.contentMeasuredForKey = previous.containerKey;
    const current = createNativeViewportMetrics();
    const publish = vi.fn<(nearBottom: boolean) => void>();

    expect(current.offsetY).toBe(0);
    expect(current.viewportMeasuredForKey).toBeNull();
    expect(current.contentMeasuredForKey).toBeNull();
    publishMeasuredNativeNearBottom({ metrics: current, threshold: 32, publish });
    expect(publish).not.toHaveBeenCalled();

    current.viewportHeight = 600;
    current.contentHeight = 1800;
    current.viewportMeasuredForKey = current.containerKey;
    current.contentMeasuredForKey = current.containerKey;
    publishMeasuredNativeNearBottom({ metrics: current, threshold: 32, publish });
    expect(publish).toHaveBeenCalledExactlyOnceWith(false);
    expect(current.offsetY).toBe(0);
    expect(previous.offsetY).toBe(1200);
  });
});

describe("native measured near-bottom publication", () => {
  it("reveals an off-bottom list when content follows layout without a scroll event", () => {
    const metrics = createNativeBottomMeasurement();
    const publish = vi.fn<(nearBottom: boolean) => void>();
    metrics.viewportHeight = 600;
    metrics.viewportMeasuredForKey = metrics.containerKey;
    publishMeasuredNativeNearBottom({ metrics, threshold: 32, publish });
    expect(publish).not.toHaveBeenCalled();

    metrics.contentHeight = 1800;
    metrics.contentMeasuredForKey = metrics.containerKey;
    publishMeasuredNativeNearBottom({ metrics, threshold: 32, publish });
    expect(publish).toHaveBeenCalledExactlyOnceWith(false);
    expect(metrics.offsetY).toBe(0);
  });

  it("reveals an off-bottom list when layout follows content without a scroll event", () => {
    const metrics = createNativeBottomMeasurement();
    const publish = vi.fn<(nearBottom: boolean) => void>();
    metrics.contentHeight = 1800;
    metrics.contentMeasuredForKey = metrics.containerKey;
    publishMeasuredNativeNearBottom({ metrics, threshold: 32, publish });
    expect(publish).not.toHaveBeenCalled();

    metrics.viewportHeight = 600;
    metrics.viewportMeasuredForKey = metrics.containerKey;
    publishMeasuredNativeNearBottom({ metrics, threshold: 32, publish });
    expect(publish).toHaveBeenCalledExactlyOnceWith(false);
    expect(metrics.offsetY).toBe(0);
  });

  it("withholds incomplete or stale-container measurements until both are current and positive", () => {
    const metrics = createNativeBottomMeasurement();
    const publish = vi.fn<(nearBottom: boolean) => void>();
    metrics.viewportMeasuredForKey = metrics.containerKey;
    metrics.contentMeasuredForKey = metrics.containerKey;
    publishMeasuredNativeNearBottom({ metrics, threshold: 32, publish });
    metrics.viewportHeight = 600;
    publishMeasuredNativeNearBottom({ metrics, threshold: 32, publish });
    metrics.contentHeight = 1800;
    metrics.viewportHeight = 0;
    publishMeasuredNativeNearBottom({ metrics, threshold: 32, publish });
    expect(publish).not.toHaveBeenCalled();

    metrics.viewportHeight = 600;
    metrics.containerKey = "rebound-container";
    publishMeasuredNativeNearBottom({ metrics, threshold: 32, publish });
    metrics.viewportMeasuredForKey = metrics.containerKey;
    publishMeasuredNativeNearBottom({ metrics, threshold: 32, publish });
    expect(publish).not.toHaveBeenCalled();
    metrics.contentMeasuredForKey = metrics.containerKey;
    publishMeasuredNativeNearBottom({ metrics, threshold: 32, publish });
    expect(publish).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("publishes fitting content and current offsets using the existing bottom threshold", () => {
    const metrics = createNativeBottomMeasurement();
    const publish = vi.fn<(nearBottom: boolean) => void>();
    metrics.viewportHeight = 600;
    metrics.contentHeight = 400;
    metrics.viewportMeasuredForKey = metrics.containerKey;
    metrics.contentMeasuredForKey = metrics.containerKey;
    publishMeasuredNativeNearBottom({ metrics, threshold: 32, publish });
    expect(publish).toHaveBeenLastCalledWith(true);

    metrics.contentHeight = 1800;
    publishMeasuredNativeNearBottom({ metrics, threshold: 32, publish });
    expect(publish).toHaveBeenLastCalledWith(false);
    metrics.offsetY = 1167;
    publishMeasuredNativeNearBottom({ metrics, threshold: 32, publish });
    expect(publish).toHaveBeenLastCalledWith(false);
    metrics.offsetY = 1168;
    publishMeasuredNativeNearBottom({ metrics, threshold: 32, publish });
    expect(publish).toHaveBeenLastCalledWith(true);
    expect(publish).toHaveBeenCalledTimes(4);
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

/** FlatList synchronously reports unmeasured indices; retry callbacks can survive cancellation. */
function nativeJumpFixture(direction: "inverted" | "chronological" = "inverted") {
  let header: number | null = 6000;
  let index = 12;
  let liveOffset: number | undefined;
  let measured = 0;
  let clock = 0;
  let failIndex = true;
  let targetTop = 8;
  let mounted = true;
  let dropMeasurements = false;
  let offset = 1000;
  const callbacks = new Set<() => void>();
  const archivedCallbacks: Array<() => void> = [];
  const onFailure = vi.fn();
  const scrollToOffset = vi.fn((value: number) => {
    targetTop += (direction === "chronological" ? -1 : 1) * (value - offset);
    offset = value;
  });
  const scrollToIndex = vi.fn((target: number) => {
    if (failIndex)
      controller.handleIndexFailure({
        index: target,
        averageItemLength: 100,
        highestMeasuredFrameIndex: measured,
      });
  });
  const controller = createNativePromptJumpController({
    direction,
    viewport: {
      findHistoryIndex: () => index,
      findLiveOffset: () => liveOffset,
      getLiveHeaderHeight: () => header,
      measureTarget: (_id, callback) => {
        if (!dropMeasurements)
          callback(mounted ? { top: targetTop, offset, maxOffset: 20000 } : null);
      },
      scrollToIndex,
      scrollToOffset,
    },
    scheduleRetry(callback) {
      callbacks.add(callback);
      archivedCallbacks.push(callback);
      return () => {
        callbacks.delete(callback);
      };
    },
    now: () => clock,
    onFailure,
  });
  return {
    controller,
    scrollToOffset,
    scrollToIndex,
    onFailure,
    archivedCallbacks,
    pending: () => callbacks.size,
    measuredTargetTop: () => targetTop,
    retry() {
      const next = callbacks.values().next().value;
      expect(next).toBeDefined();
      callbacks.delete(next!);
      next!();
    },
    dropMeasurements() {
      dropMeasurements = true;
    },
    setMounted(value: boolean) {
      mounted = value;
    },
    setTargetTop(value: number) {
      targetTop = value;
    },
    setHeader(value: number | null) {
      header = value;
    },
    setLiveOffset(value: number) {
      liveOffset = value;
    },
    setIndex(value: number) {
      index = value;
    },
    setMeasured(value: number) {
      measured = value;
    },
    setClock(value: number) {
      clock = value;
    },
    succeed() {
      failIndex = false;
    },
  };
}

describe("native prompt viewport recovery", () => {
  it("bounds a native node that never returns its measurement callback", () => {
    const f = nativeJumpFixture();
    f.succeed();
    f.dropMeasurements();
    f.controller.start("prompt");
    while (f.pending()) f.retry();
    expect(f.onFailure).toHaveBeenCalledWith("prompt");
    expect(f.controller.isActive()).toBe(false);
  });
  it("waits for a mounted bubble rather than accepting estimated index frames", () => {
    const f = nativeJumpFixture();
    f.succeed();
    f.setMounted(false);
    f.controller.start("prompt");
    f.retry();
    expect(f.controller.isActive()).toBe(true);
    expect(f.scrollToIndex).toHaveBeenCalledTimes(2);
    f.setMounted(true);
    f.retry();
    f.retry();
    expect(f.controller.isActive()).toBe(false);
  });
  it("cancels an accepted jump before its queued landing check", () => {
    const f = nativeJumpFixture();
    f.succeed();
    f.setTargetTop(180);
    f.controller.start("prompt");
    const stale = f.archivedCallbacks[0]!;
    f.controller.cancel();
    stale();
    expect(f.scrollToOffset).not.toHaveBeenCalled();
    expect(f.pending()).toBe(0);
  });
  it("corrects an accepted scroll whose cell frame settles short on the first tap", () => {
    const f = nativeJumpFixture();
    f.succeed();
    f.setTargetTop(180);
    f.controller.start("prompt");
    expect(f.controller.isActive()).toBe(true);
    f.retry();
    expect(f.scrollToOffset).toHaveBeenLastCalledWith(828, false);
    // A later layout change must invalidate the first apparent landing.
    f.setTargetTop(48);
    f.retry();
    expect(f.scrollToOffset).toHaveBeenLastCalledWith(788, false);
    f.retry();
    expect(f.controller.isActive()).toBe(true);
    f.retry();
    expect(f.controller.isActive()).toBe(false);
    expect(f.onFailure).not.toHaveBeenCalled();
  });
  it("includes long measured live header, rebases stable ID, then lands exactly", () => {
    const f = nativeJumpFixture();
    f.controller.start("prompt");
    expect(f.scrollToOffset).toHaveBeenLastCalledWith(7200, false);
    f.setIndex(14);
    f.succeed();
    f.retry();
    expect(f.scrollToIndex).toHaveBeenLastCalledWith(14);
    f.setTargetTop(8);
    f.retry();
    f.retry();
    expect(f.controller.isActive()).toBe(false);
    expect(f.onFailure).not.toHaveBeenCalled();
  });
  it("waits for an unmeasured header rather than treating it as zero", () => {
    const f = nativeJumpFixture();
    f.setHeader(null);
    f.controller.start("prompt");
    expect(f.scrollToOffset).not.toHaveBeenCalled();
    f.setHeader(9000);
    f.retry();
    expect(f.scrollToOffset).toHaveBeenLastCalledWith(10200, false);
  });
  it("stops repeated no-progress retries and reports the same target", () => {
    const f = nativeJumpFixture();
    f.controller.start("prompt");
    for (let i = 0; i < 3; i++) f.retry();
    expect(f.onFailure).toHaveBeenCalledWith("prompt");
    expect(f.scrollToIndex).toHaveBeenCalledTimes(4);
    expect(f.pending()).toBe(0);
  });
  it("does not reset attempt budget when measurements keep changing", () => {
    const f = nativeJumpFixture();
    f.controller.start("prompt");
    for (let i = 1; i < 8; i++) {
      f.setMeasured(i);
      f.retry();
    }
    expect(f.scrollToIndex).toHaveBeenCalledTimes(8);
    expect(f.pending()).toBe(0);
    expect(f.onFailure).toHaveBeenCalledTimes(1);
  });
  it("cancels stale callbacks on bottom, another jump or lifecycle cleanup", () => {
    const f = nativeJumpFixture();
    f.controller.start("first");
    const stale = f.archivedCallbacks[0]!;
    f.controller.cancel();
    stale();
    expect(f.scrollToIndex).toHaveBeenCalledTimes(1);
    f.controller.start("second");
    stale();
    expect(f.scrollToIndex).toHaveBeenCalledTimes(2);
    f.controller.cancel();
    f.archivedCallbacks.at(-1)!();
    expect(f.pending()).toBe(0);
    expect(f.onFailure).not.toHaveBeenCalled();
  });
  it("bounds wall time and reports a missing stable target", () => {
    const f = nativeJumpFixture();
    f.controller.start("prompt");
    f.setClock(2000);
    f.retry();
    expect(f.onFailure).toHaveBeenCalledTimes(1);
    f.setIndex(-1);
    f.controller.start("missing");
    expect(f.onFailure).toHaveBeenLastCalledWith("missing");
    expect(f.pending()).toBe(0);
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

import {
  resolveNativeReadingPosition,
  resolveNativeLivePromptOffset,
} from "./native-reading-position";

it("native viewability selects the chronological reading edge and records visible original bubbles", () => {
  const user = {
    id: "history-user",
    kind: "user_message",
    text: "prompt",
    timestamp: new Date(0),
  } as StreamItem;
  const answer = { ...user, id: "answer", kind: "assistant_message" } as StreamItem;
  const position = resolveNativeReadingPosition({
    visibleHistory: [
      { item: answer, index: 2, isViewable: true },
      { item: user, index: 3, isViewable: true },
    ],
    liveHead: [],
    liveGeometry: new Map(),
    headerHeight: 100,
    viewportHeight: 600,
    offsetY: 400,
  });
  expect(position).toEqual({ rowId: "history-user", visibleUserIds: ["history-user"] });
});

it("native reading preserves ordering and header geometry without ES2023 array methods", () => {
  const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, "toSorted");
  const user = (id: string): StreamItem => ({
    id,
    kind: "user_message",
    text: "prompt",
    timestamp: new Date(0),
  });
  const first = user("history-first");
  const second = user("history-second");
  const live = user("live-user");
  const answer: StreamItem = {
    id: "live-answer",
    kind: "assistant_message",
    text: "response",
    timestamp: new Date(0),
  };
  const visibleHistory = Object.freeze([
    { item: second, index: 2, isViewable: true },
    { item: user("hidden"), index: 99, isViewable: false },
    { item: first, index: 7, isViewable: true },
  ]);
  const original = [...visibleHistory];
  const input = {
    visibleHistory,
    liveHead: [live, answer],
    liveGeometry: new Map([
      [live.id, { y: 0, height: 100 }],
      [answer.id, { y: 100, height: 5900 }],
    ]),
    headerHeight: 6000,
    viewportHeight: 600,
    offsetY: 5350,
  };
  try {
    Reflect.deleteProperty(Array.prototype, "toSorted");
    expect(resolveNativeReadingPosition({ ...input, headerHeight: null })).toEqual({
      rowId: first.id,
      visibleUserIds: [first.id, second.id],
    });
    expect(resolveNativeReadingPosition(input)).toEqual({
      rowId: live.id,
      visibleUserIds: [first.id, second.id, live.id],
    });
    expect(resolveNativeReadingPosition({ ...input, offsetY: 5300 })).toEqual({
      rowId: answer.id,
      visibleUserIds: [first.id, second.id],
    });
    expect(visibleHistory).toEqual(original);
    expect(visibleHistory.map((token) => token.index)).toEqual([2, 99, 7]);
  } finally {
    if (descriptor) Reflect.defineProperty(Array.prototype, "toSorted", descriptor);
    else Reflect.deleteProperty(Array.prototype, "toSorted");
  }
});

it("native measured live header tracks the original leaving view without DOM APIs", () => {
  const user = {
    id: "live-user",
    kind: "user_message",
    text: "prompt",
    timestamp: new Date(0),
  } as StreamItem;
  const answer = { ...user, id: "live-answer", kind: "assistant_message" } as StreamItem;
  const input = {
    visibleHistory: [],
    liveHead: [user, answer],
    headerHeight: 6000,
    liveGeometry: new Map([
      [user.id, { y: 0, height: 100 }],
      [answer.id, { y: 100, height: 5900 }],
    ]),
    viewportHeight: 600,
  };
  expect(resolveNativeReadingPosition({ ...input, offsetY: 5350 })).toEqual({
    rowId: user.id,
    visibleUserIds: [user.id],
  });
  expect(resolveNativeReadingPosition({ ...input, offsetY: 5300 })).toEqual({
    rowId: answer.id,
    visibleUserIds: [],
  });
  expect(resolveNativeLivePromptOffset(6000, 600, 100)).toBe(5300);
  expect(resolveNativeLivePromptOffset(300, 600, 100)).toBe(0);
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

describe("scroll driven prompt handoff", () => {
  it("transfers ownership exactly at the edge and reverses without overlapping alpha", () => {
    expect([8, 0, -24, -48, -100, -24, 8].map(resolvePromptHandoffProgress)).toEqual([
      0, 1, 1, 1, 1, 1, 0,
    ]);
  });
  it("accepts same-target progress without starvation and rejects stale native measurements", () => {
    const viewport: ((rect: NativePromptWindowRect | null) => void)[] = [];
    const prompts: ((rect: NativePromptWindowRect | null) => void)[] = [];
    const measured = vi.fn();
    const sampler = createNativePromptHandoffSampler({
      measureViewport: (callback) => viewport.push(callback),
      measurePrompt: (_id, callback) => prompts.push(callback),
      onMeasured: measured,
    });
    sampler.sample("first");
    sampler.sample("first");
    viewport[0]!(viewportRect(100));
    viewport[1]!(viewportRect(100));
    prompts[0]!(bubbleRect(76));
    expect(measured).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: "first",
        progress: 1,
        top: -24,
        left: 90,
        width: 180,
        viewportWidth: 320,
      }),
    );
    prompts[1]!(bubbleRect(52));
    expect(measured).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "first", progress: 1, top: -48 }),
    );
    sampler.sample("first");
    viewport[2]!(viewportRect(100));
    sampler.sample("second");
    prompts[2]!(bubbleRect(80));
    expect(measured).toHaveBeenCalledTimes(2);
    viewport[3]!(viewportRect(100));
    sampler.cancel();
    prompts[3]!(bubbleRect(60));
    expect(measured).toHaveBeenCalledTimes(2);
  });
});

it("measures both overlapping native prompts with a bounded pair", () => {
  const requests: { id: string; complete: (rect: NativePromptWindowRect | null) => void }[] = [];
  const measured = vi.fn();
  const pair = createNativePromptHandoffPair({
    measureViewport: (callback) => callback(viewportRect(100)),
    measurePrompt: (id, complete) => requests.push({ id, complete }),
    onMeasured: measured,
  });
  pair.sample(["older", "newer", "outside-budget"]);
  expect(requests.map((request) => request.id)).toEqual(["older", "newer"]);
  requests[0]!.complete(bubbleRect(80));
  requests[1]!.complete(bubbleRect(124));
  expect(measured).toHaveBeenCalledWith(
    expect.objectContaining({ id: "older", progress: 1, top: -20 }),
  );
  expect(measured).toHaveBeenCalledWith(
    expect.objectContaining({ id: "newer", progress: 0, top: 24 }),
  );
  pair.sample(["newer"]);
  pair.cancel();
  requests[2]!.complete(bubbleRect(90));
  expect(measured).toHaveBeenCalledTimes(2);
});

/** Window-space rectangles include an inset so tests prove viewport-relative positioning. */
function viewportRect(y: number): NativePromptWindowRect {
  return { x: 10, y, width: 320, height: 600 };
}
function bubbleRect(y: number): NativePromptWindowRect {
  return { x: 100, y, width: 180, height: 60, prefixHeightOne: 20, prefixHeightTwo: 40 };
}

it("ignores zero native geometry and retains actual bubble prefix extents", () => {
  const measured = vi.fn();
  let viewport = { ...viewportRect(100), width: 0 };
  const sampler = createNativePromptHandoffSampler({
    measureViewport: (complete) => complete(viewport),
    measurePrompt: (_id, complete) => complete(bubbleRect(100)),
    onMeasured: measured,
  });
  sampler.sample("prompt");
  expect(measured).not.toHaveBeenCalled();
  viewport = viewportRect(100);
  sampler.sample("prompt");
  expect(measured).toHaveBeenCalledWith(
    expect.objectContaining({
      id: "prompt",
      progress: 1,
      top: 0,
      left: 90,
      width: 180,
      prefixHeightOne: 20,
      prefixHeightTwo: 40,
    }),
  );
});

it("waits for native text layout before publishing a copy and accepts an explicit empty prefix", () => {
  const measured = vi.fn();
  let bubble: NativePromptWindowRect = {
    ...bubbleRect(99),
    prefixHeightOne: undefined,
    prefixHeightTwo: undefined,
  };
  const sampler = createNativePromptHandoffSampler({
    measureViewport: (complete) => complete(viewportRect(100)),
    measurePrompt: (_id, complete) => complete(bubble),
    onMeasured: measured,
  });
  sampler.sample("prompt");
  expect(measured).not.toHaveBeenCalled();
  bubble = bubbleRect(99);
  sampler.sample("prompt");
  expect(measured).toHaveBeenCalledWith(
    expect.objectContaining({ id: "prompt", top: -1, prefixHeightOne: 20 }),
  );
  bubble = { ...bubbleRect(100), prefixHeightOne: 0, prefixHeightTwo: 0 };
  sampler.sample("attachments-only");
  expect(measured).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: "attachments-only", progress: 1, prefixHeightOne: 0 }),
  );
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

  it("uses the same measured pinned destination in the inverted native controller", () => {
    const f = nativeJumpFixture();
    f.succeed();
    f.setTargetTop(8);
    f.controller.start("prompt", "pinned");
    while (f.pending()) f.retry();
    expect(f.scrollToOffset).toHaveBeenCalledWith(990, false);
    expect(f.onFailure).not.toHaveBeenCalled();
    expect(f.controller.isActive()).toBe(false);
  });
});

describe("actual prompt row ownership", () => {
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

describe("actual native row coordinates", () => {
  it("keeps bottom distance independent of keyboard displacement and leading inset normalization", () => {
    const height = 1800,
      viewport = 600,
      offset = 1160;
    expect(nativeBottomDistance(height, 0, viewport, offset)).toBe(40);
    expect(nativeBottomDistance(height, 20, viewport, offset)).toBe(60);
    // Native top inset, if installed elsewhere, normalizes H and y together.
    expect(nativeBottomDistance(height + 80, 0, viewport, offset + 80)).toBe(40);
  });
  it("measures original top at the stationary clip while the actual child is sticky", () => {
    expect(nativeOriginalTop(900, 750, 100, 100)).toBe(150);
    expect(nativeOriginalTop(900, 750, -200, 100)).toBe(-150);
    const translation = nativeStickyTranslation(750 + 300, 900, 53, null);
    expect(translation).toBe(150);
    expect(nativeOriginalTop(900, 750, -200, 100) + translation).toBe(0);
    const headerInset = 64;
    const belowHeader = nativeStickyTranslation(750 + 300 + headerInset, 900, 53, null);
    expect(belowHeader).toBe(214);
    expect(nativeOriginalTop(900, 750, -200, 100 + headerInset) + belowHeader).toBe(0);
  });
  it("matches RN uncapped unknown or overlapping next-header interpolation", () => {
    expect(nativeStickyTranslation(700, 100, 53, null)).toBe(600);
    expect(nativeStickyTranslation(700, 100, 53, 120)).toBe(600);
    expect(nativeStickyTranslation(99, 100, 53, null)).toBe(0);
  });
  it("caps both drivers at the same measured next prompt collision", () => {
    expect(nativeStickyTranslation(300, 100, 53, 500)).toBe(200);
    expect(nativeStickyTranslation(600, 100, 53, 500)).toBe(347);
    const t0 = nativeStickyTranslation(440, 100, 53, 500);
    const tk = nativeStickyTranslation(440 + 300, 100, 53, 500);
    expect(tk - t0).toBe(7);
    expect(100 - 440 - 300 + tk).toBe(-293);
  });
  it("delivers the original absolute wrapper event once to the list callback", () => {
    const channel = createNativeStickyLayout<{ y: number; height: number }>();
    const cell = vi.fn();
    const stop = channel.subscribe(cell);
    const event = { y: 900, height: 53 };
    channel.publish(event);
    expect(cell).toHaveBeenCalledExactlyOnceWith(event);
    stop();
    channel.publish({ y: 1000, height: 53 });
    expect(cell).toHaveBeenCalledTimes(1);
  });
  it("replays latest real layout to a late subscriber but never across position identities", () => {
    const channel = createNativeStickyLayout<number>({ key: "prompt", index: 2 });
    expect(channel.position).toEqual({ key: "prompt", index: 2 });
    channel.publish(900);
    const cell = vi.fn();
    channel.subscribe(cell);
    expect(cell).toHaveBeenCalledExactlyOnceWith(900);
    const newPosition = createNativeStickyLayout<number>({ key: "prompt", index: 3 });
    const changedIndex = vi.fn();
    newPosition.subscribe(changedIndex);
    expect(changedIndex).not.toHaveBeenCalled();
    newPosition.publish(1100);
    expect(changedIndex).toHaveBeenCalledExactlyOnceWith(1100);
  });
});

describe("chronological native prompt settling", () => {
  it("moves forward to the actual original row and confirms two real landings", () => {
    const f = nativeJumpFixture("chronological");
    f.succeed();
    f.setTargetTop(280);
    f.controller.start("prompt", "original");
    f.retry();
    expect(f.scrollToOffset).toHaveBeenLastCalledWith(1272, false);
    f.retry();
    f.retry();
    expect(f.controller.isActive()).toBe(false);
    expect(f.onFailure).not.toHaveBeenCalled();
  });
  it("pins at the measured effective leading edge without a copied preview", () => {
    const f = nativeJumpFixture("chronological");
    f.succeed();
    f.setTargetTop(280);
    f.controller.start("prompt", "pinned");
    f.retry();
    expect(f.scrollToOffset).toHaveBeenLastCalledWith(1282, false);
    f.retry();
    f.retry();
    expect(f.controller.isActive()).toBe(false);
    expect(f.measuredTargetTop()).toBe(-2);
    expect(f.onFailure).not.toHaveBeenCalled();
  });
  it("recovers an unmeasured index using the one measured leading reservation", () => {
    const f = nativeJumpFixture("chronological");
    f.setHeader(332);
    f.controller.start("prompt");
    expect(f.scrollToOffset).toHaveBeenLastCalledWith(1532, false);
    f.succeed();
    f.retry();
    while (f.pending()) f.retry();
    expect(f.onFailure).not.toHaveBeenCalled();
  });
  it("cancels stale native measurements and timers without scrolling a new session", () => {
    const f = nativeJumpFixture("chronological");
    f.succeed();
    f.setTargetTop(280);
    f.controller.start("prompt");
    f.controller.cancel();
    for (const callback of f.archivedCallbacks) callback();
    expect(f.scrollToOffset).not.toHaveBeenCalled();
    expect(f.onFailure).not.toHaveBeenCalled();
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

function effectiveNativeReadingFixture() {
  const items: StreamItem[] = [
    {
      id: "old",
      kind: "user_message",
      text: "old",
      timestamp: new Date(0),
      timelineCursor: { epoch: "epoch", seq: 1000 },
    },
    {
      id: "old-answer",
      kind: "assistant_message",
      text: "old answer",
      timestamp: new Date(0),
      timelineCursor: { epoch: "epoch", seq: 1100 },
    },
    {
      id: "later",
      kind: "user_message",
      text: "later",
      timestamp: new Date(0),
      timelineCursor: { epoch: "epoch", seq: 1250 },
    },
    {
      id: "later-answer",
      kind: "assistant_message",
      text: "later answer",
      timestamp: new Date(0),
      timelineCursor: { epoch: "epoch", seq: 1303 },
    },
  ];
  const geometry = new Map<string, ActualNativeRowGeometry>([
    ["old", { index: 0, y: 1000, height: 100 }],
    ["old-answer", { index: 1, y: 1100, height: 150 }],
    ["later", { index: 2, y: 1250, height: 53 }],
    ["later-answer", { index: 3, y: 1303, height: 297 }],
  ]);
  return {
    items,
    geometry,
    headers: createNativeMeasuredHeaderIndex({ items, geometry }),
    mounted: new Set(items.map((item) => item.id)),
    offset: 1000,
    viewportHeight: 600,
    clippedLeading: 300,
    stickyEnabled: true,
  };
}
describe("actual native effective reading selection", () => {
  it("publishes the later canonical turn when raw viewable rows are wholly behind the stationary clip", () => {
    expect(resolveActualNativeReading(effectiveNativeReadingFixture())).toEqual({
      pinnedId: "later",
      rowId: "later",
      seq: 1250,
      visibleUserIds: ["later"],
    });
  });
  it("keeps original row order and user visibility with K zero", () => {
    expect(
      resolveActualNativeReading({ ...effectiveNativeReadingFixture(), clippedLeading: 0 }),
    ).toEqual({ pinnedId: "old", rowId: "old", seq: 1000, visibleUserIds: ["old", "later"] });
  });
  it("counts the actual retained sticky prompt while reading the straddling original assistant", () => {
    const fixture = effectiveNativeReadingFixture();
    fixture.geometry.set("later", { index: 2, y: 1250, height: 40 });
    fixture.geometry.set("later-answer", { index: 3, y: 1290, height: 310 });
    expect(resolveActualNativeReading(fixture)).toEqual({
      pinnedId: "later",
      rowId: "later-answer",
      seq: 1303,
      visibleUserIds: ["later"],
    });
    expect(resolveActualNativeReading({ ...fixture, stickyEnabled: false })).toEqual({
      pinnedId: null,
      rowId: "later-answer",
      seq: 1303,
      visibleUserIds: [],
    });
  });
  it("rejects unmounted/stale-index geometry and an entirely occluded pane", () => {
    const fixture = effectiveNativeReadingFixture();
    fixture.mounted.delete("later");
    fixture.geometry.set("old", { index: 99, y: 1000, height: 100 });
    expect(resolveActualNativeReading(fixture)).toEqual({
      pinnedId: null,
      rowId: "later-answer",
      seq: 1303,
      visibleUserIds: [],
    });
    expect(resolveActualNativeReading({ ...fixture, clippedLeading: 600 })).toEqual({
      pinnedId: null,
      rowId: null,
      seq: null,
      visibleUserIds: [],
    });
  });
});

describe("native mounted reading geometry", () => {
  it("uses chronological indices when mounted and measured insertion orders are reversed", () => {
    const fixture = effectiveNativeReadingFixture();
    fixture.mounted = new Set([...fixture.mounted].toReversed());
    fixture.geometry = new Map([...fixture.geometry].toReversed());
    fixture.headers = createNativeMeasuredHeaderIndex(fixture);
    const reading = resolveActualNativeReading({ ...fixture, offset: 1100, clippedLeading: 0 });

    expect(reading.pinnedId).toBe("old");
    expect(reading.rowId).toBe("old-answer");
    expect(reading.seq).toBe(1100);
    expect(reading.visibleUserIds.join(",")).toBe("old,later");
  });

  it("excludes pre-prepend geometry until current-index layouts are accepted", () => {
    const fixture = effectiveNativeReadingFixture();
    const prefix: StreamItem = {
      id: "prefix",
      kind: "user_message",
      text: "earlier",
      timestamp: new Date(0),
      timelineCursor: { epoch: "epoch", seq: 900 },
    };
    const items = [prefix, ...fixture.items];
    const headers = createNativeMeasuredHeaderIndex({ items, geometry: fixture.geometry });
    const input = { ...fixture, items, headers };
    const stale = resolveActualNativeReading(input);

    expect(stale.pinnedId).toBeNull();
    expect(stale.rowId).toBeNull();
    expect(stale.seq).toBeNull();
    expect(stale.visibleUserIds.length).toBe(0);
    expect(headers.nextTop(0)).toBeNull();

    for (const [id, previous] of fixture.geometry) {
      const row = { index: previous.index + 1, y: previous.y, height: previous.height };
      fixture.geometry.set(id, row);
      headers.record(id, row);
    }
    const current = resolveActualNativeReading(input);
    expect(current.pinnedId).toBe("later");
    expect(current.rowId).toBe("later");
    expect(current.seq).toBe(1250);
    expect(current.visibleUserIds.join(",")).toBe("later");
  });

  it("retains an unmounted zero-height successor but removes stale-index collision evidence", () => {
    const fixture = effectiveNativeReadingFixture();
    const successor = { index: 2, y: 1100, height: 0 };
    fixture.geometry.set("later", successor);
    fixture.headers.record("later", successor);
    fixture.mounted.delete("later");
    const input = { ...fixture, offset: 1100, clippedLeading: 0, viewportHeight: 100 };

    expect(fixture.headers.nextTop(0)).toBe(1100);
    const hidden = resolveActualNativeReading(input);
    expect(hidden.pinnedId).toBeNull();
    expect(hidden.rowId).toBe("old-answer");
    expect(hidden.visibleUserIds.length).toBe(0);

    fixture.mounted.add("later");
    expect(resolveActualNativeReading(input).pinnedId).toBeNull();
    const staleSuccessor = { index: 99, y: 1100, height: 0 };
    fixture.geometry.set("later", staleSuccessor);
    fixture.headers.record("later", staleSuccessor);
    expect(fixture.headers.nextTop(0)).toBeNull();
    const retained = resolveActualNativeReading(input);
    expect(retained.pinnedId).toBe("old");
    expect(retained.rowId).toBe("old-answer");
    expect(retained.visibleUserIds.join(",")).toBe("old");
  });

  it("updates only measured USER successors and reads current metadata after list rebinding", () => {
    const fixture = effectiveNativeReadingFixture();
    fixture.headers.clear();
    expect(fixture.headers.nextTop(0)).toBeNull();
    fixture.headers.record("old-answer", { index: 1, y: 1200, height: 100 });
    expect(fixture.headers.nextTop(0)).toBeNull();
    fixture.headers.record("later", { index: 2, y: 1500, height: 0 });
    expect(fixture.headers.nextTop(0)).toBe(1500);
    fixture.headers.record("later", { index: 2, y: 1250, height: 53 });
    expect(fixture.headers.nextTop(0)).toBe(1250);

    const withoutLater = [fixture.items[0], fixture.items[1], fixture.items[3]];
    const removed = createNativeMeasuredHeaderIndex({
      items: withoutLater,
      geometry: fixture.geometry,
    });
    expect(removed.nextTop(0)).toBeNull();

    const items = fixture.items.map((item, index) =>
      Object.assign({}, item, { timelineCursor: { epoch: "next-epoch", seq: 40 + index } }),
    );
    const headers = createNativeMeasuredHeaderIndex({ items, geometry: fixture.geometry });
    const reading = resolveActualNativeReading({ ...fixture, items, headers });
    expect(reading.pinnedId).toBe("later");
    expect(reading.rowId).toBe("later");
    expect(reading.seq).toBe(42);
    expect(reading.visibleUserIds.join(",")).toBe("later");
  });

  it("reads mounted indices without traversing a large chronological history", () => {
    const items = Array.from({ length: 10_000 }, (_, index): StreamItem => {
      const kind = index === 0 || index === 9999 ? "user_message" : "assistant_message";
      return {
        id: `row-${index}`,
        kind,
        text: "row",
        timestamp: new Date(0),
        timelineCursor: { epoch: "epoch", seq: index },
      };
    });
    let indexedReads = 0;
    const countedItems = new Proxy(items, {
      get(target, property, receiver) {
        if (property === Symbol.iterator || property === "entries") {
          throw new Error("A reading calculation must not traverse chronological history");
        }
        if (typeof property === "string" && /^\d+$/.test(property)) indexedReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const geometry = new Map([
      ["row-0", { index: 0, y: 0, height: 50 }],
      ["row-5000", { index: 5000, y: 500, height: 100 }],
      ["row-9999", { index: 9999, y: 900, height: 0 }],
    ]);
    const headers = createNativeMeasuredHeaderIndex({ items: countedItems, geometry });
    indexedReads = 0;
    for (let index = 0; index < 20; index += 1) {
      const reading = resolveActualNativeReading({
        items: countedItems,
        geometry,
        headers,
        mounted: new Set(["row-5000", "row-0"]),
        offset: 500,
        clippedLeading: 0,
        viewportHeight: 100,
        stickyEnabled: true,
      });
      expect(reading.pinnedId).toBe("row-0");
      expect(reading.rowId).toBe("row-5000");
      expect(reading.seq).toBe(5000);
      expect(reading.visibleUserIds.join(",")).toBe("row-0");
    }
    expect(indexedReads).toBeLessThanOrEqual(160);
  });

  it("rejects an async measurement after a row or scope rebind before publication", () => {
    const fixture = effectiveNativeReadingFixture();
    const pending = {
      request: 7,
      latestRequest: 7,
      headers: fixture.headers,
      currentHeaders: fixture.headers,
    };
    expect(isCurrentNativeReading(pending)).toBe(true);
    const rowRebind = createNativeMeasuredHeaderIndex({
      items: [...fixture.items],
      geometry: fixture.geometry,
    });
    expect(isCurrentNativeReading({ ...pending, currentHeaders: rowRebind })).toBe(false);
    const scopeRebind = createNativeMeasuredHeaderIndex(fixture);
    expect(isCurrentNativeReading({ ...pending, currentHeaders: scopeRebind })).toBe(false);
    expect(isCurrentNativeReading({ ...pending, latestRequest: 8 })).toBe(false);
    expect(
      isCurrentNativeReading({ ...pending, headers: rowRebind, currentHeaders: rowRebind }),
    ).toBe(true);
  });
});

describe("actual native motion owner topology", () => {
  it("uses the actual unshifted child viewport as its stationary measurement edge", () => {
    const mode = resolveNativeMotionOwner(true, false, false);
    expect(mode).toBe("standalone");
    const viewport = { top: 20 };
    const owner = resolveNativeMeasurementOwner(mode, viewport, null)!;
    expect(owner.viewport).toBe(viewport);
    expect(owner.clip).toBe(viewport);
    expect(nativeOriginalTop(1250, 1000, owner.viewport.top, owner.clip.top)).toBe(250);
    expect(nativeStickyTranslation(1000, 1250, 53, null)).toBe(0);
  });
  it("retains the real dock measurement owner and physical K even when a child is eligible for standalone", () => {
    const mode = resolveNativeMotionOwner(true, true, true);
    expect(mode).toBe("docked");
    const viewport = { top: -200 };
    const clip = { top: 100 };
    const owner = resolveNativeMeasurementOwner(mode, viewport, clip)!;
    expect(owner.viewport).toBe(viewport);
    expect(owner.clip).toBe(clip);
    expect(nativeOriginalTop(1250, 1000, owner.viewport.top, owner.clip.top)).toBe(-50);
    expect(nativeStickyTranslation(1000 + 300, 1250, 53, null)).toBe(50);
  });
  it("rejects partial/missing dock contracts and waits for actual refs rather than guessing zero", () => {
    expect(() => resolveNativeMotionOwner(false, false, false)).toThrow("owners must match");
    expect(() => resolveNativeMotionOwner(true, true, false)).toThrow("owners must match");
    expect(() => resolveNativeMotionOwner(true, false, true)).toThrow("owners must match");
    expect(resolveNativeMeasurementOwner("docked", { top: -200 }, null)).toBeNull();
    expect(resolveNativeMeasurementOwner("standalone", null, null)).toBeNull();
  });
});
