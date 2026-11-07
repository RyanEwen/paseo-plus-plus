import { describe, expect, it } from "vitest";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import {
  measuredHeightStyle,
  measuredWidthStyle,
  naturalBubbleFrameStyle,
  previewTextClipStyle,
  trailingRailStyles,
} from "./user-message-measured-styles";

// Unistyles web adds a CSS rule for every distinct ordinary style object and never removes it.
// Measured prompt geometry changes per message, resize and disclosure, so it must use the
// inline lane (docs/unistyles.md, "Dynamic Pixel Styles On Web").
describe("measured prompt styles stay out of the Unistyles web stylesheet", () => {
  it("keeps the natural bubble frame inline", () => {
    expect(naturalBubbleFrameStyle({ width: 240, height: 96 })).toEqual(
      inlineUnistylesStyle({ width: 240, height: 96 }),
    );
    expect(naturalBubbleFrameStyle({ width: undefined, height: undefined })).toBeUndefined();
  });

  it("keeps measured preview widths and heights inline", () => {
    expect(measuredWidthStyle(180)).toEqual(inlineUnistylesStyle({ width: 180 }));
    expect(measuredHeightStyle(40)).toEqual(inlineUnistylesStyle({ height: 40 }));
    expect(measuredWidthStyle(undefined)).toBeUndefined();
    expect(measuredHeightStyle(undefined)).toBeUndefined();
  });

  it("keeps the translated preview clip inline", () => {
    expect(
      previewTextClipStyle({
        width: 200,
        compact: true,
        web: true,
        translateX: 0,
        translateY: -18,
      }),
    ).toEqual(
      inlineUnistylesStyle({
        width: 200,
        overflow: "hidden",
        transform: [{ translateX: 0 }, { translateY: -18 }],
      }),
    );
  });

  it("keeps the web trailing rails inline", () => {
    expect(trailingRailStyles({ railWidth: 300, padding: 8 })).toEqual({
      paint: inlineUnistylesStyle({ maxWidth: 316, marginLeft: -8, marginRight: -8 }),
      content: inlineUnistylesStyle({ maxWidth: 300, minWidth: 0, flexShrink: 1 }),
    });
  });
});
