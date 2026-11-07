import type { ViewStyle } from "react-native";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";

/**
 * Styles built from measured prompt geometry. These values change per message, per resize
 * and per More/Less. Each builder returns its object through the inline lane so Unistyles web
 * does not add a stylesheet rule per distinct value (docs/unistyles.md).
 */

/** The natural bubble frame the flow measured, or undefined while unmeasured. */
export function naturalBubbleFrameStyle(frame: {
  width: number | undefined;
  height: number | undefined;
}): ViewStyle | undefined {
  if (frame.width === undefined && frame.height === undefined) return undefined;
  const style: ViewStyle = {};
  if (frame.width !== undefined) style.width = frame.width;
  if (frame.height !== undefined) style.height = frame.height;
  return inlineUnistylesStyle(style);
}

/** A measured width, or undefined while unmeasured. */
export function measuredWidthStyle(width: number | undefined): ViewStyle | undefined {
  return width === undefined ? undefined : inlineUnistylesStyle({ width });
}

/** A measured height, or undefined while unmeasured. */
export function measuredHeightStyle(height: number | undefined): ViewStyle | undefined {
  return height === undefined ? undefined : inlineUnistylesStyle({ height });
}

/**
 * The clipped preview text frame. Web skips an identity transform so the text keeps its
 * original horizontal position and wrapping.
 */
export function previewTextClipStyle(input: {
  width: number | undefined;
  compact: boolean;
  web: boolean;
  translateX: number;
  translateY: number;
}): ViewStyle {
  const untranslated = input.translateX === 0 && input.translateY === 0;
  return inlineUnistylesStyle({
    width: input.width,
    overflow: input.compact ? "hidden" : "visible",
    transform:
      input.web && untranslated
        ? undefined
        : [{ translateX: input.translateX }, { translateY: input.translateY }],
  });
}

/**
 * The web trailing row's paint and content rails. A prepared rail width widens the paint by
 * the backing padding on both sides so the backing aligns with the bubble.
 */
export function trailingRailStyles(input: { railWidth: number | undefined; padding: number }): {
  paint: ViewStyle;
  content: ViewStyle;
} {
  const prepared = input.railWidth !== undefined && input.railWidth > 0;
  const railWidth = input.railWidth ?? 0;
  return {
    paint: inlineUnistylesStyle({
      maxWidth: prepared ? railWidth + input.padding * 2 : "100%",
      marginLeft: prepared ? -input.padding : 0,
      marginRight: prepared ? -input.padding : 0,
    }),
    content: inlineUnistylesStyle({
      maxWidth: prepared ? railWidth : "100%",
      minWidth: 0,
      flexShrink: 1,
    }),
  };
}
