import { describe, expect, it } from "vitest";
import {
  computePosition,
  getCursorAnchorRect,
  getPointerAnchorRect,
  getTransformOrigin,
  type Rect,
} from "./anchor";

const DISPLAY: Rect = { x: 0, y: 0, width: 1000, height: 800 };
const TRIGGER: Rect = { x: 100, y: 100, width: 40, height: 20 };
const CONTENT = { width: 200, height: 100 };

function position(overrides: Partial<Parameters<typeof computePosition>[0]> = {}) {
  return computePosition({
    triggerRect: TRIGGER,
    contentSize: CONTENT,
    displayArea: DISPLAY,
    placement: "bottom",
    alignment: "start",
    offset: 4,
    ...overrides,
  });
}

describe("computePosition", () => {
  it("sits below the trigger with room to spare", () => {
    expect(position()).toEqual({ x: 100, y: 124, actualPlacement: "bottom" });
  });

  it("aligns to the trigger's start, center, and end edges", () => {
    expect(position({ alignment: "start" }).x).toBe(100);
    expect(position({ alignment: "center" }).x).toBe(20);
    // 100 + 40 - 200 = -60, pulled back to the edge padding.
    expect(position({ alignment: "end" }).x).toBe(8);
  });

  it("flips above the trigger when it does not fit below and there is more room above", () => {
    const result = position({
      triggerRect: { ...TRIGGER, y: 700 },
      contentSize: { width: 200, height: 200 },
    });
    expect(result.actualPlacement).toBe("top");
    expect(result.y).toBe(496);
  });

  it("stays put when flipping would be just as cramped", () => {
    // Taller than the whole display area: neither side fits, so flipping buys nothing.
    const result = position({
      displayArea: { x: 0, y: 0, width: 1000, height: 300 },
      contentSize: { width: 200, height: 400 },
    });
    expect(result.actualPlacement).toBe("bottom");
  });

  it("places side placements flush with the trigger top and ignores alignment", () => {
    const left = position({ placement: "left", alignment: "end" });
    expect(left).toEqual({ x: 8, y: 100, actualPlacement: "left" });

    const right = position({ placement: "right", alignment: "end" });
    expect(right).toEqual({ x: 144, y: 100, actualPlacement: "right" });
  });

  it("lets hover cards flip horizontally when the opposite side has room", () => {
    const result = position({
      triggerRect: { ...TRIGGER, x: 850 },
      placement: "right",
      flipHorizontal: true,
    });
    expect(result).toEqual({ x: 646, y: 100, actualPlacement: "left" });
    expect(
      position({ triggerRect: { ...TRIGGER, x: 850 }, placement: "right" }).actualPlacement,
    ).toBe("right");
  });

  it("keeps the surface inside a display area that does not start at the origin", () => {
    // Regression: the horizontal clamp used to ignore displayArea.x while the vertical one
    // honoured displayArea.y, so an offset display area pushed the surface off its left edge.
    const result = position({
      displayArea: { x: 100, y: 0, width: 900, height: 800 },
      alignment: "end",
    });
    expect(result.x).toBe(108);
  });
});

describe("getTransformOrigin", () => {
  it.each([
    ["bottom", "start", [0, 0, 0]],
    ["bottom", "center", ["50%", 0, 0]],
    ["bottom", "end", ["100%", 0, 0]],
    ["top", "start", [0, "100%", 0]],
    ["top", "center", ["50%", "100%", 0]],
    ["top", "end", ["100%", "100%", 0]],
    ["left", "start", [0, "50%", 0]],
    ["left", "center", ["50%", "50%", 0]],
    ["left", "end", ["100%", "50%", 0]],
    ["right", "start", [0, "50%", 0]],
    ["right", "center", ["50%", "50%", 0]],
    ["right", "end", ["100%", "50%", 0]],
  ] as const)("emits a native-ready origin for %s/%s", (placement, alignment, expected) => {
    // Theme updates may reach Fabric without React Native's JS string preprocessing.
    expect(getTransformOrigin(placement, alignment)).toEqual(expected);
  });
});

describe("pointer-anchored divider cards", () => {
  it("opens beside the pointer halfway down a tall divider instead of its top", () => {
    expect(
      position({
        triggerRect: getPointerAnchorRect(
          { x: 400, y: 40, width: 10, height: 700 },
          { x: 405, y: 520 },
          "right",
        ),
        placement: "right",
        flipHorizontal: true,
      }),
    ).toEqual({ x: 414, y: 520, actualPlacement: "right" });
  });
  it("centers a horizontal-divider card near the pointer and flips above the bottom edge", () => {
    expect(
      position({
        triggerRect: getPointerAnchorRect(
          { x: 0, y: 750, width: 1000, height: 10 },
          { x: 650, y: 755 },
          "bottom",
        ),
        placement: "bottom",
        alignment: "center",
      }),
    ).toEqual({ x: 550, y: 646, actualPlacement: "top" });
  });
  it("retains viewport clamping and flips to the left at the right edge", () => {
    expect(
      position({
        triggerRect: getPointerAnchorRect(
          { x: 950, y: 0, width: 10, height: 800 },
          { x: 955, y: 790 },
          "right",
        ),
        placement: "right",
        flipHorizontal: true,
      }),
    ).toEqual({ x: 746, y: 692, actualPlacement: "left" });
  });
  it("keeps trigger-based positioning when opened without a pointer", () => {
    expect(getPointerAnchorRect(TRIGGER, null, "right")).toBe(TRIGGER);
  });
});

describe("cursor-anchored divider cards", () => {
  it("opens below the cursor at the midpoint of a tall vertical divider", () => {
    const cursor = { x: 760, y: 394 };
    const triggerRect = getCursorAnchorRect({ x: 750, y: 0, width: 20, height: 800 }, cursor);

    expect(
      position({
        triggerRect,
        alignment: "center",
        offset: 4,
      }),
    ).toEqual({ x: 660, y: 398, actualPlacement: "bottom" });
  });

  it("opens below the cursor at the midpoint of a horizontal divider", () => {
    const triggerRect = getCursorAnchorRect(
      { x: 0, y: 390, width: 1600, height: 8 },
      { x: 760, y: 394 },
    );

    expect(
      position({
        triggerRect,
        alignment: "center",
        offset: 4,
      }),
    ).toEqual({ x: 660, y: 398, actualPlacement: "bottom" });
  });

  it("clamps the cursor to the trigger and keeps viewport flip and clamp behavior", () => {
    expect(
      getCursorAnchorRect({ x: 100, y: 200, width: 40, height: 20 }, { x: 999, y: 0 }),
    ).toEqual({ x: 140, y: 200, width: 0, height: 0 });

    const triggerRect = getCursorAnchorRect(
      { x: 0, y: 0, width: 1000, height: 800 },
      { x: 995, y: 790 },
    );
    expect(
      position({
        triggerRect,
        alignment: "center",
        offset: 4,
      }),
    ).toEqual({ x: 792, y: 686, actualPlacement: "top" });
  });

  it("keeps trigger-based positioning when opened without a cursor", () => {
    expect(getCursorAnchorRect(TRIGGER, null)).toBe(TRIGGER);
  });
});
