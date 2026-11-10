import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { ComponentRef } from "react";
import type { View } from "react-native";
import { SPACING } from "@/styles/theme";
import type { MessageFlowContext, UserMessageFlowProps } from "./flow";
import { sameFrame, type MessageFlowFrame, type MessageFlowMeasurements } from "./flow-model";

type FrameName = Parameters<MessageFlowContext["register"]>[0];
export interface WebMessageMeasurement {
  binding: object;
  font: string;
  textHeight: number;
  summaryWidth: number;
  summaryHeight: number;
  visualTrailingHeight: number;
  compactTrailingHeight: number | null;
  metrics: MessageFlowMeasurements;
  corners: string;
}

function sameMeasurement(left: WebMessageMeasurement | null, right: WebMessageMeasurement) {
  return (
    left !== null &&
    left.binding === right.binding &&
    left.font === right.font &&
    left.textHeight === right.textHeight &&
    left.summaryWidth === right.summaryWidth &&
    left.summaryHeight === right.summaryHeight &&
    left.visualTrailingHeight === right.visualTrailingHeight &&
    left.compactTrailingHeight === right.compactTrailingHeight &&
    left.corners === right.corners &&
    left.metrics.width === right.metrics.width &&
    left.metrics.bodyHeight === right.metrics.bodyHeight &&
    left.metrics.trailingHeight === right.metrics.trailingHeight &&
    left.metrics.prefixHeight === right.metrics.prefixHeight &&
    sameFrame(left.metrics.bubble, right.metrics.bubble) &&
    sameFrame(left.metrics.content, right.metrics.content) &&
    sameFrame(left.metrics.text, right.metrics.text) &&
    sameFrame(left.metrics.controls, right.metrics.controls)
  );
}

function frame(node: HTMLElement, origin: HTMLElement): MessageFlowFrame {
  const bounds = node.getBoundingClientRect();
  const parent = origin.getBoundingClientRect();
  return {
    x: bounds.left - parent.left,
    y: bounds.top - parent.top,
    width: bounds.width,
    height: bounds.height,
  };
}

/** The one live content lane retains its ordinary inline layout while its
 * parent paints pinned padding. The visual host is measured separately for caps.
 */
function trailingHeights(trailing: HTMLElement, compactPadding: number) {
  const row = trailing.querySelector<HTMLElement>('[data-testid="user-message-trailing-row"]');
  if (!row) return { natural: 0, compact: 0 };
  const content = row.querySelector<HTMLElement>('[data-testid="user-message-action-content"]');
  if (!content) return { natural: null, compact: null };
  const height = content.getBoundingClientRect().height;
  return { natural: height + SPACING[2], compact: height + compactPadding };
}

/** Read the one full Text's actual first line. Range geometry retains glyph
 * wrapping even while its ancestor clips paint or its inner viewport scrolls.
 */
function textGeometry(text: HTMLElement | null) {
  if (!text) return { height: 0, prefixHeight: 0, font: "" };
  const range = document.createRange();
  range.selectNodeContents(text);
  const first = Array.from(range.getClientRects()).find(
    (rect) => rect.height > 0 && rect.width > 0,
  );
  const style = getComputedStyle(text);
  const lineHeight = Number.parseFloat(style.lineHeight);
  return {
    height: text.getBoundingClientRect().height,
    prefixHeight: Number.isFinite(lineHeight) ? lineHeight : (first?.height ?? 0),
    font: `${style.font}:${style.lineHeight}:${style.letterSpacing}`,
  };
}

interface WebMessageNodes {
  rail: RefObject<HTMLDivElement | null>;
  body: RefObject<HTMLDivElement | null>;
  trailing: RefObject<HTMLDivElement | null>;
  summary: RefObject<HTMLDivElement | null>;
  frames: Map<FrameName, HTMLElement>;
}

/** Ordinary previews allocate their committed clip, toggle and caller chrome.
 * The hidden full Text remains searchable but does not enlarge this allocation.
 */
/** The mounted measurement nodes, or null until every one exists at a usable width. */
function readMeasurementNodes(nodes: WebMessageNodes, width: number) {
  const body = nodes.body.current;
  const trailing = nodes.trailing.current;
  const bubble = nodes.frames.get("bubble");
  const content = nodes.frames.get("content");
  const text = nodes.frames.get("text");
  const controls = nodes.frames.get("controls");
  if (!body || !trailing || !bubble || !content || !text || !controls || !(width > 0)) return null;
  return { body, trailing, bubble, content, textFrame: text, controls };
}

function measuredText(content: HTMLElement) {
  return content.querySelector<HTMLElement>('[data-testid="user-message-text"]');
}

function bubbleCorners(style: CSSStyleDeclaration): string {
  return `${style.borderTopLeftRadius} ${style.borderTopRightRadius} ${style.borderBottomRightRadius} ${style.borderBottomLeftRadius}`;
}

/** The summary size, which a compact preview may not have mounted. */
function summarySize(nodes: WebMessageNodes) {
  const bounds = nodes.summary.current?.getBoundingClientRect();
  return { summaryWidth: bounds?.width ?? 0, summaryHeight: bounds?.height ?? 0 };
}

function readOrdinaryPreviewMeasurement(
  nodes: WebMessageNodes,
  binding: object,
  width: number,
): WebMessageMeasurement | null {
  const found = readMeasurementNodes(nodes, width);
  if (!found) return null;
  const { body, trailing, bubble, content, textFrame, controls } = found;
  const ink = textGeometry(measuredText(content));
  const trailingHeight = trailing.getBoundingClientRect().height;
  return {
    binding,
    font: ink.font,
    textHeight: ink.height,
    ...summarySize(nodes),
    visualTrailingHeight: trailingHeight,
    compactTrailingHeight: trailingHeight,
    corners: bubbleCorners(getComputedStyle(bubble)),
    metrics: {
      width,
      bodyHeight: body.getBoundingClientRect().height,
      trailingHeight,
      bubble: frame(bubble, body),
      content: frame(content, bubble),
      text: frame(textFrame, content),
      prefixHeight: ink.prefixHeight,
      controls: frame(controls, nodes.rail.current ?? body),
    },
  };
}

function readNaturalMeasurement(
  nodes: WebMessageNodes,
  binding: object,
  width: number,
  compactTrailingPadding: number,
): WebMessageMeasurement | null {
  const found = readMeasurementNodes(nodes, width);
  if (!found) return null;
  const { body, trailing, bubble, content, textFrame, controls } = found;
  const text = measuredText(content);
  const ink = textGeometry(text);
  const trailingHeight = trailingHeights(trailing, compactTrailingPadding);
  const naturalText = frame(textFrame, content);
  // The compact clip cannot own the layout measurement. Its full natural Text
  // remains present, and its measured wrapper reserves exactly that live extent.
  const textDelta = text ? ink.height - naturalText.height : 0;
  const bubbleStyle = getComputedStyle(bubble);
  const paddingOwner = content.parentElement;
  if (!paddingOwner) return null;
  const naturalHeight =
    paddingOwner.getBoundingClientRect().height +
    textDelta +
    Number.parseFloat(bubbleStyle.paddingTop) +
    Number.parseFloat(bubbleStyle.paddingBottom) +
    Number.parseFloat(bubbleStyle.borderTopWidth) +
    Number.parseFloat(bubbleStyle.borderBottomWidth);
  const naturalWidth =
    paddingOwner.getBoundingClientRect().width +
    Number.parseFloat(bubbleStyle.paddingLeft) +
    Number.parseFloat(bubbleStyle.paddingRight) +
    Number.parseFloat(bubbleStyle.borderLeftWidth) +
    Number.parseFloat(bubbleStyle.borderRightWidth);
  return {
    binding,
    font: ink.font,
    textHeight: ink.height,
    ...summarySize(nodes),
    visualTrailingHeight: trailing.getBoundingClientRect().height,
    compactTrailingHeight: trailingHeight.compact,
    corners: bubbleCorners(bubbleStyle),
    metrics: {
      width,
      bodyHeight: naturalHeight,
      trailingHeight: trailingHeight.natural,
      bubble: { ...frame(bubble, body), width: naturalWidth, height: naturalHeight },
      content: {
        ...frame(content, bubble),
        height: content.getBoundingClientRect().height + textDelta,
      },
      text: { ...naturalText, height: ink.height },
      prefixHeight: ink.prefixHeight,
      controls: frame(controls, nodes.rail.current ?? body),
    },
  };
}

/**
 * Synchronous state updates one hook may make before its next read waits for an animation
 * frame. Layout effects and ResizeObserver callbacks run inside one synchronous React chain,
 * so this keeps every chain far below React's nested update limit (#185).
 */
const SYNC_UPDATES_PER_FRAME = 3;

/**
 * Width and font re-binds allowed for one set of real inputs (content, presentation and
 * disclosure). Past it, layout that never settles keeps the last measurement instead of
 * measuring again; a real input change starts a new budget.
 */
const REBINDS_PER_INPUT = 8;

/** How much measuring one hook may still do before waiting or settling. */
interface MeasurementBudget {
  inputs: object | null;
  rebinds: number;
  measurements: number;
  syncUpdates: number;
  frame: number | null;
  pending: boolean;
  last: WebMessageMeasurement | null;
}

/** Measurement updates allowed for one set of real inputs, such as images loading. */
const MEASUREMENTS_PER_INPUT = 32;

/** Rail widths within this distance are the same layout, not a reason to re-bind. */
const RAIL_WIDTH_TOLERANCE_PX = 1;

function sameRailWidth(left: number, right: number): boolean {
  return Math.abs(left - right) < RAIL_WIDTH_TOLERANCE_PX;
}

/** Two widths the rail has been flipping between since the last genuinely new width. */
interface RailWidthOscillation {
  first: number;
  second: number;
}

/**
 * The width to bind for a measured rail. Re-binding changes layout, and that layout can move
 * the rail back (for example a scrollbar that appears only at one width). Once the rail
 * returns to the width it just left, hold the current width while it stays on that pair;
 * any other width is a real change and re-binds.
 */
function settleRailWidth(input: {
  current: number;
  actual: number;
  previous: number | null;
  oscillation: RailWidthOscillation | null;
}): { width: number; oscillation: RailWidthOscillation | null } {
  const { current, actual, previous, oscillation } = input;
  if (sameRailWidth(actual, current)) return { width: current, oscillation };
  if (
    oscillation &&
    (sameRailWidth(actual, oscillation.first) || sameRailWidth(actual, oscillation.second))
  ) {
    return { width: current, oscillation };
  }
  if (previous !== null && sameRailWidth(actual, previous)) {
    return { width: current, oscillation: { first: previous, second: current } };
  }
  return { width: actual, oscillation: null };
}

/** A layout-bound web adapter for the existing natural-flow contract. Content,
 * rail width and font changes release preparation before measuring again in
 * ordinary layout. Scroll position is never an input or an invalidation source.
 */
export function useWebMessageMeasurements(
  props: Pick<
    UserMessageFlowProps,
    "revision" | "bounded" | "compact" | "controls" | "compactTrailingPadding" | "bodyPresentation"
  >,
) {
  const rail = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const trailing = useRef<HTMLDivElement>(null);
  const summary = useRef<HTMLDivElement>(null);
  const frames = useRef(new Map<FrameName, HTMLElement>());
  const observedText = useRef<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);
  const compactTrailingPadding = props.compactTrailingPadding ?? 0;
  const bodyPresentation = props.bodyPresentation ?? "actualPrompt";
  const [fontRevision, setFontRevision] = useState(0);
  const binding = useMemo(
    () => ({ revision: props.revision, width, fontRevision, bodyPresentation }),
    [props.revision, width, fontRevision, bodyPresentation],
  );
  const current = useRef(binding);
  const font = useRef<{ binding: object; value: string } | null>(null);
  // Each content and width gets one font retry, so a font string that never matches cannot
  // keep re-binding.
  const fontRetry = useRef<{ revision: object; width: number } | null>(null);
  const previousWidth = useRef<number | null>(null);
  const widthOscillation = useRef<RailWidthOscillation | null>(null);
  const budget = useRef<MeasurementBudget>({
    inputs: null,
    rebinds: 0,
    measurements: 0,
    syncUpdates: 0,
    frame: null,
    pending: false,
    last: null,
  });
  // Real inputs, as opposed to the width and font this hook measures for itself.
  const inputs = useMemo(
    () => ({
      revision: props.revision,
      bodyPresentation,
      bounded: props.bounded,
      compact: props.compact,
      controls: props.controls,
      compactTrailingPadding,
    }),
    [
      props.revision,
      bodyPresentation,
      props.bounded,
      props.compact,
      props.controls,
      compactTrailingPadding,
    ],
  );
  const readCurrent = useRef<() => void>(() => {});
  /** The next animation frame restores the sync budget and runs any deferred read, once. */
  const scheduleBudgetFrame = useCallback(() => {
    const state = budget.current;
    if (state.frame !== null) return;
    state.frame = requestAnimationFrame(() => {
      state.frame = null;
      state.syncUpdates = 0;
      if (!state.pending) return;
      state.pending = false;
      readCurrent.current();
    });
  }, []);
  /** Measure again on the next animation frame instead of now. */
  const deferRead = useCallback(() => {
    budget.current.pending = true;
    scheduleBudgetFrame();
  }, [scheduleBudgetFrame]);
  /** Spend one synchronous state update from this frame's budget. */
  const spendSyncUpdate = useCallback(() => {
    budget.current.syncUpdates += 1;
    scheduleBudgetFrame();
  }, [scheduleBudgetFrame]);
  const [measurement, setMeasurement] = useState<WebMessageMeasurement | null>(null);
  const read = useCallback(() => {
    if (current.current !== binding) return;
    const state = budget.current;
    if (state.inputs !== inputs) {
      state.inputs = inputs;
      state.rebinds = 0;
      state.measurements = 0;
    }
    // Past this frame's synchronous budget, measure on the next frame instead of now.
    if (state.syncUpdates >= SYNC_UPDATES_PER_FRAME) {
      deferRead();
      return;
    }
    const canRebind = state.rebinds < REBINDS_PER_INPUT;
    const actualWidth = rail.current?.getBoundingClientRect().width ?? 0;
    const settled = settleRailWidth({
      current: width,
      actual: actualWidth,
      previous: previousWidth.current,
      oscillation: widthOscillation.current,
    });
    widthOscillation.current = settled.oscillation;
    if (settled.width !== width && canRebind) {
      previousWidth.current = width;
      state.rebinds += 1;
      spendSyncUpdate();
      setWidth(settled.width);
      return;
    }
    const nodes = { rail, body, trailing, summary, frames: frames.current };
    const next =
      bodyPresentation === "ordinaryPreview"
        ? readOrdinaryPreviewMeasurement(nodes, binding, width)
        : readNaturalMeasurement(nodes, binding, width, compactTrailingPadding);
    if (!next) return;
    const fontChanged = font.current?.binding === binding && font.current.value !== next.font;
    const fontRetried =
      fontRetry.current?.revision === props.revision && fontRetry.current.width === width;
    if (fontChanged && !fontRetried && canRebind) {
      fontRetry.current = { revision: props.revision, width };
      state.rebinds += 1;
      spendSyncUpdate();
      setFontRevision((value) => value + 1);
      return;
    }
    font.current = { binding, value: next.font };
    // Never set an equal measurement, and stop once layout has had its budget of changes.
    if (sameMeasurement(state.last, next) || state.measurements >= MEASUREMENTS_PER_INPUT) return;
    state.last = next;
    state.measurements += 1;
    spendSyncUpdate();
    setMeasurement(next);
  }, [
    binding,
    width,
    compactTrailingPadding,
    bodyPresentation,
    props.revision,
    inputs,
    deferRead,
    spendSyncUpdate,
  ]);
  const observer = useMemo(() => new ResizeObserver(() => readCurrent.current()), []);
  const registerElement = useCallback(
    (name: FrameName, node: HTMLElement | null) => {
      const previous = frames.current.get(name);
      if (previous) observer.unobserve(previous);
      if (name === "text" && observedText.current) {
        observer.unobserve(observedText.current);
        observedText.current = null;
      }
      if (node) {
        frames.current.set(name, node);
        observer.observe(node);
        const text =
          name === "text"
            ? node.querySelector<HTMLElement>('[data-testid="user-message-text"]')
            : null;
        if (text) {
          observedText.current = text;
          observer.observe(text);
        }
      } else {
        frames.current.delete(name);
      }
    },
    [observer],
  );
  const register = useCallback(
    (name: FrameName, node: ComponentRef<typeof View> | null) => {
      registerElement(name, node instanceof HTMLElement ? node : null);
    },
    [registerElement],
  );
  const registerControls = useCallback(
    (node: HTMLDivElement | null) => registerElement("controls", node),
    [registerElement],
  );
  useLayoutEffect(() => {
    current.current = binding;
    readCurrent.current = read;
    for (const node of [
      rail.current,
      body.current,
      trailing.current,
      summary.current,
      ...frames.current.values(),
      observedText.current,
    ]) {
      if (node) observer.observe(node);
    }
    read();
  }, [binding, read, observer, props.bounded, props.compact, props.controls]);
  useLayoutEffect(() => {
    const invalidateFont = () => setFontRevision((value) => value + 1);
    document.fonts?.addEventListener("loadingdone", invalidateFont);
    const state = budget.current;
    return () => {
      observer.disconnect();
      document.fonts?.removeEventListener("loadingdone", invalidateFont);
      if (state.frame !== null) cancelAnimationFrame(state.frame);
      state.frame = null;
    };
  }, [observer]);
  const reportFrame = useCallback(() => readCurrent.current(), []);
  const reportText = useCallback(() => readCurrent.current(), []);
  return {
    rail,
    body,
    trailing,
    summary,
    register,
    registerControls,
    reportFrame,
    reportText,
    width,
    measurement: measurement?.binding === binding ? measurement : null,
  };
}
