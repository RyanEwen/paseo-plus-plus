import { nativeTextPreviewMetrics } from "./native-text-preview-metrics";
import { memo, useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import {
  Text,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
  type TextProps,
  type TextLayoutEvent,
} from "react-native";

/** Native measures its actual natural Text, never a hidden second renderer. The
 * clip ends at the measured final visible line. No native ellipsizing is applied
 * before measurement, so newline/wrapping/font changes report real overflow. */
export const TextPreview = memo(function TextPreview({
  children,
  numberOfLines,
  expanded = false,
  onOverflowChange,
  onTextLayout,
  style,
  onKeyDown: _onKeyDown,
  tabIndex: _tabIndex,
  ...props
}: TextProps & {
  children: string;
  numberOfLines: number;
  expanded?: boolean;
  onOverflowChange(overflowing: boolean): void;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  tabIndex?: number;
}) {
  const { fontScale } = useWindowDimensions();
  const [width, setWidth] = useState(0);
  const [measurement, setMeasurement] = useState<{
    text: string;
    height: number;
    count: number;
    lines: number;
    width: number;
    fontScale: number;
  } | null>(null);
  const measure = useCallback(
    (event: TextLayoutEvent) => {
      const lines = event.nativeEvent.lines;
      const { height } = nativeTextPreviewMetrics(lines, numberOfLines);
      setMeasurement((previous) =>
        previous?.text === children &&
        previous.height === height &&
        previous.count === lines.length &&
        previous.lines === numberOfLines &&
        previous.width === width &&
        previous.fontScale === fontScale
          ? previous
          : { text: children, height, count: lines.length, lines: numberOfLines, width, fontScale },
      );
      onTextLayout?.(event);
    },
    [children, numberOfLines, onTextLayout, width, fontScale],
  );
  const current =
    measurement?.text === children &&
    measurement.lines === numberOfLines &&
    measurement.width === width &&
    measurement.fontScale === fontScale
      ? measurement
      : null;
  useEffect(() => {
    if (current) onOverflowChange(current.count > numberOfLines);
  }, [current, numberOfLines, onOverflowChange]);
  const clip = useMemo(
    () => ({
      minWidth: 0,
      flexShrink: 1,
      overflow: "hidden" as const,
      height: expanded ? undefined : current?.height,
    }),
    [expanded, current?.height],
  );
  const textStyle = useMemo(() => [style, { flexShrink: 0 }], [style]);
  const measureWidth = useCallback((event: LayoutChangeEvent) => {
    setWidth(event.nativeEvent.layout.width);
  }, []);
  return (
    <View style={clip} onLayout={measureWidth}>
      <Text {...props} style={textStyle} onTextLayout={measure}>
        {children}
      </Text>
    </View>
  );
});
