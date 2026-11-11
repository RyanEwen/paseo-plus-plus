import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { useLayoutUpdateBudget } from "@/hooks/use-layout-update-budget";
import { isWeb } from "@/constants/platform";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { StyleSheet, Text, View, type TextProps } from "react-native";

/** Overflow may change direction this many times for one input before it is held on. */
const OVERFLOW_FLIPS_PER_INPUT = 2;

function renderedLineHeight(element: HTMLElement): number {
  if (!isWeb) return 0;
  const specified = Number.parseFloat(window.getComputedStyle(element).lineHeight);
  if (Number.isFinite(specified) && specified > 0) return specified;
  const range = document.createRange();
  range.selectNodeContents(element);
  const lines = [...range.getClientRects()].filter((rect) => rect.height > 0);
  const first = lines[0];
  const next = first && lines.find((rect) => rect.top > first.top);
  return first && next ? next.top - first.top : element.getBoundingClientRect().height;
}

/** A single persistent full-text node supplies wrapping and selection. Only its parent
 * clips the collapsed presentation; no inaccessible second text/probe is rendered.
 */
export const TextPreview = memo(function TextPreview({
  children,
  numberOfLines,
  expanded = false,
  onOverflowChange,
  onKeyDown,
  tabIndex,
  ...props
}: TextProps & {
  children: string;
  numberOfLines: number;
  expanded?: boolean;
  onOverflowChange: (overflowing: boolean) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  tabIndex?: number;
}) {
  const ref = useRef<Text>(null);
  const [measurement, setMeasurement] = useState({ lineHeight: 0, overflowing: false });
  // Callers often build their style inline, so re-measure for a changed style, not for a
  // fresh object with the same values.
  const styleKey = useMemo(
    () => JSON.stringify(StyleSheet.flatten(props.style) ?? null),
    [props.style],
  );
  const inputs = useMemo(
    () => ({ children, numberOfLines, expanded, styleKey }),
    [children, numberOfLines, expanded, styleKey],
  );
  const latest = useRef(measurement);
  const flips = useRef({ inputs, count: 0 });
  const measureRef = useRef<() => void>(() => {});
  const retryMeasure = useCallback(() => measureRef.current(), []);
  const spendLayoutUpdate = useLayoutUpdateBudget(retryMeasure);
  const measure = useCallback(() => {
    if (!isWeb || !(ref.current instanceof HTMLElement)) return;
    const element = ref.current;
    const bounds = element.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const lineHeight = renderedLineHeight(element);
    const measuredOverflow =
      bounds.height > lineHeight * numberOfLines || element.scrollWidth > element.clientWidth;
    if (flips.current.inputs !== inputs) flips.current = { inputs, count: 0 };
    const current = latest.current;
    // When overflow keeps changing the layout that produced it, hold the clamped state
    // instead of flipping on every layout pass.
    const held = flips.current.count >= OVERFLOW_FLIPS_PER_INPUT;
    const overflowing = held ? true : measuredOverflow;
    if (current.lineHeight === lineHeight && current.overflowing === overflowing) return;
    if (!spendLayoutUpdate()) return;
    if (current.overflowing !== overflowing) flips.current.count += 1;
    const next = { lineHeight, overflowing };
    latest.current = next;
    setMeasurement(next);
  }, [numberOfLines, inputs, spendLayoutUpdate]);
  useLayoutEffect(() => {
    measureRef.current = measure;
  }, [measure]);
  useLayoutEffect(measure, [measure]);
  useEffect(() => {
    if (!isWeb || !(ref.current instanceof HTMLElement)) return;
    let active = true;
    const refresh = () => {
      if (active) measure();
    };
    const observer = new ResizeObserver(refresh);
    observer.observe(ref.current);
    document.fonts?.addEventListener("loadingdone", refresh);
    void document.fonts?.ready.then(refresh);
    return () => {
      active = false;
      observer.disconnect();
      document.fonts?.removeEventListener("loadingdone", refresh);
    };
  }, [measure]);
  useEffect(
    () => onOverflowChange(measurement.overflowing),
    [measurement.overflowing, onOverflowChange],
  );
  const clipStyle = useMemo(
    () => [
      styles.clip,
      inlineUnistylesStyle({
        maxHeight:
          !expanded && measurement.lineHeight > 0
            ? measurement.lineHeight * numberOfLines
            : undefined,
      }),
    ],
    [expanded, measurement.lineHeight, numberOfLines],
  );
  const textStyle = useMemo(
    () => [
      props.style,
      inlineUnistylesStyle({
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
        alignSelf: "stretch" as const,
      }),
    ],
    [props.style],
  );
  return (
    <View style={clipStyle} testID="text-preview-clip">
      <Text {...props} {...{ onKeyDown, tabIndex }} ref={ref} style={textStyle}>
        {children}
      </Text>
    </View>
  );
});

const styles = { clip: { minWidth: 0, flexShrink: 1, overflow: "hidden" as const } };
