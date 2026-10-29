import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { ComponentRef } from "react";
import type { View } from "react-native";
import { SPACING } from "@/styles/theme";
import type { MessageFlowContext, UserMessageFlowProps } from "./user-message-flow";
import type { MessageFlowFrame, MessageFlowMeasurements } from "./user-message-flow-model";

type FrameName = Parameters<MessageFlowContext["register"]>[0];
interface WebMessageMeasurement {
  binding: object;
  font: string;
  textHeight: number;
  summaryWidth: number;
  summaryHeight: number;
  visualTrailingHeight: number;
  metrics: MessageFlowMeasurements;
  corners: string;
}

function sameFrame(left: MessageFlowFrame | null, right: MessageFlowFrame | null) {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.x === right.x &&
      left.y === right.y &&
      left.width === right.width &&
      left.height === right.height)
  );
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
function ordinaryTrailingHeight(trailing: HTMLElement): number | null {
  const row = trailing.querySelector<HTMLElement>('[data-testid="user-message-trailing-row"]');
  if (!row) return 0;
  const content = row.querySelector<HTMLElement>('[data-testid="user-message-action-content"]');
  return content ? content.getBoundingClientRect().height + SPACING[2] : null;
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

function readNaturalMeasurement(
  nodes: WebMessageNodes,
  binding: object,
  width: number,
): WebMessageMeasurement | null {
  const body = nodes.body.current;
  const trailing = nodes.trailing.current;
  const bubble = nodes.frames.get("bubble");
  const content = nodes.frames.get("content");
  const textFrame = nodes.frames.get("text");
  const controls = nodes.frames.get("controls");
  if (!body || !trailing || !bubble || !content || !textFrame || !controls || !(width > 0))
    return null;
  const text = content.querySelector<HTMLElement>('[data-testid="user-message-text"]');
  const ink = textGeometry(text);
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
    summaryWidth: nodes.summary.current?.getBoundingClientRect().width ?? 0,
    summaryHeight: nodes.summary.current?.getBoundingClientRect().height ?? 0,
    visualTrailingHeight: trailing.getBoundingClientRect().height,
    corners: `${bubbleStyle.borderTopLeftRadius} ${bubbleStyle.borderTopRightRadius} ${bubbleStyle.borderBottomRightRadius} ${bubbleStyle.borderBottomLeftRadius}`,
    metrics: {
      width,
      bodyHeight: naturalHeight,
      trailingHeight: ordinaryTrailingHeight(trailing),
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

/** A layout-bound web adapter for the existing natural-flow contract. Content,
 * rail width and font changes release preparation before measuring again in
 * ordinary layout. Scroll position is never an input or an invalidation source.
 */
export function useWebMessageMeasurements(
  props: Pick<UserMessageFlowProps, "revision" | "bounded" | "compact" | "controls">,
) {
  const rail = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const trailing = useRef<HTMLDivElement>(null);
  const summary = useRef<HTMLDivElement>(null);
  const frames = useRef(new Map<FrameName, HTMLElement>());
  const observedText = useRef<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);
  const [fontRevision, setFontRevision] = useState(0);
  const binding = useMemo(
    () => ({ revision: props.revision, width, fontRevision }),
    [props.revision, width, fontRevision],
  );
  const current = useRef(binding);
  const font = useRef<{ binding: object; value: string } | null>(null);
  const [measurement, setMeasurement] = useState<WebMessageMeasurement | null>(null);
  const read = useCallback(() => {
    if (current.current !== binding) return;
    const actualWidth = rail.current?.getBoundingClientRect().width ?? 0;
    if (actualWidth !== width) {
      setWidth(actualWidth);
      return;
    }
    const next = readNaturalMeasurement(
      { rail, body, trailing, summary, frames: frames.current },
      binding,
      width,
    );
    if (!next) return;
    if (font.current?.binding === binding && font.current.value !== next.font) {
      setFontRevision((value) => value + 1);
      return;
    }
    font.current = { binding, value: next.font };
    setMeasurement((previous) => (sameMeasurement(previous, next) ? previous : next));
  }, [binding, width]);
  const readCurrent = useRef(read);
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
    return () => {
      observer.disconnect();
      document.fonts?.removeEventListener("loadingdone", invalidateFont);
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
