import { useCallback, useEffect, useRef, useState } from "react";
import { Text, type LayoutChangeEvent, type TextLayoutEvent } from "react-native";
import { isWeb } from "@/constants/platform";

/** Box sizes a web text element reports; a subset of HTMLElement. */
export interface WebTextBox {
  clientWidth: number;
  clientHeight: number;
  scrollWidth: number;
}

/**
 * Decide native overflow from the clamped text's layout and the unbounded probe's height.
 * Returns null until both have positive geometry, so hidden retained surfaces keep their state.
 */
export function resolveNativeTextOverflow(input: {
  width: number;
  height: number;
  fullHeight: number;
}): boolean | null {
  if (input.width <= 0 || input.height <= 0 || input.fullHeight <= 0) return null;
  return input.fullHeight > input.height;
}

/**
 * Decide web overflow. A single-line caller compares the visible element's scroll width; a
 * clamped preview compares the unbounded probe against the clamped element. Returns null while
 * either element has no size.
 */
export function resolveWebTextOverflow(
  visible: WebTextBox,
  full: WebTextBox | null,
): boolean | null {
  if (visible.clientWidth <= 0 || visible.clientHeight <= 0) return null;
  if (!full) return visible.scrollWidth > visible.clientWidth;
  if (full.clientWidth <= 0 || full.clientHeight <= 0) return null;
  return full.clientHeight > visible.clientHeight || full.scrollWidth > full.clientWidth;
}

/** Measure rendered text overflow. Existing single-line callers need only the visible ref.
 * Clamped previews also mount an identical, unbounded Text at the same width and attach
 * fullRef/onFullLayout. Both platforms compare actual full/clamped layout heights.
 * Hidden retained surfaces preserve their last positive measurement.
 */
export function useTextOverflow(text: string, numberOfLines = 1) {
  const ref = useRef<Text>(null);
  const fullRef = useRef<Text>(null);
  const width = useRef(0);
  const height = useRef(0);
  const fullHeight = useRef(0);
  const [overflowing, setOverflowing] = useState(false);
  const measure = useCallback(() => {
    let next: boolean | null;
    if (!isWeb) {
      next = resolveNativeTextOverflow({
        width: width.current,
        height: height.current,
        fullHeight: fullHeight.current,
      });
    } else {
      if (!ref.current) return;
      next = resolveWebTextOverflow(
        ref.current as unknown as HTMLElement,
        fullRef.current as unknown as HTMLElement | null,
      );
    }
    // null means the surface is hidden or not measured yet; keep the last decision.
    if (next !== null) setOverflowing(next);
  }, []);
  useEffect(() => {
    if (!isWeb || !ref.current) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(ref.current as unknown as HTMLElement);
    if (fullRef.current) observer.observe(fullRef.current as unknown as HTMLElement);
    return () => observer.disconnect();
  }, [measure, numberOfLines, text]);
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      width.current = event.nativeEvent.layout.width;
      height.current = event.nativeEvent.layout.height;
      measure();
    },
    [measure],
  );
  const onTextLayout = useCallback((event: TextLayoutEvent) => {
    if (!isWeb && width.current > 0 && height.current > 0) {
      setOverflowing(event.nativeEvent.lines.some((line) => line.width > width.current));
    }
  }, []);
  const onFullTextLayout = useCallback(
    (_event: TextLayoutEvent) => {
      measure();
    },
    [measure],
  );
  const onFullLayout = useCallback(
    (event: LayoutChangeEvent) => {
      // Android's TextLayout event remeasures at rounded bounds and can report an
      // extra line for text that fits. The laid-out probe height is authoritative.
      const layout = event.nativeEvent.layout;
      fullHeight.current = layout.width > 0 ? layout.height : 0;
      measure();
    },
    [measure],
  );
  return { ref, fullRef, onLayout, onTextLayout, onFullLayout, onFullTextLayout, overflowing };
}
