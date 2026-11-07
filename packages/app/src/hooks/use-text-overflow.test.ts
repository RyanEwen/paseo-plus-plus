// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import type { LayoutChangeEvent, TextLayoutEvent } from "react-native";
import { describe, expect, it, vi } from "vitest";
import {
  resolveNativeTextOverflow,
  resolveWebTextOverflow,
  useTextOverflow,
} from "./use-text-overflow";

function layoutEvent(width: number, height = 48): LayoutChangeEvent {
  return {
    nativeEvent: {
      layout: {
        width,
        height,
        x: 0,
        y: 0,
      },
    },
  } as LayoutChangeEvent;
}

describe("resolveNativeTextOverflow", () => {
  it("waits for positive geometry from both the clamped text and the probe", () => {
    expect(resolveNativeTextOverflow({ width: 0, height: 24, fullHeight: 48 })).toBeNull();
    expect(resolveNativeTextOverflow({ width: 200, height: 0, fullHeight: 48 })).toBeNull();
    expect(resolveNativeTextOverflow({ width: 200, height: 24, fullHeight: 0 })).toBeNull();
  });

  it("overflows only when the unbounded probe is taller than the clamped text", () => {
    expect(resolveNativeTextOverflow({ width: 200, height: 24, fullHeight: 48 })).toBe(true);
    expect(resolveNativeTextOverflow({ width: 200, height: 24, fullHeight: 24 })).toBe(false);
  });
});

describe("resolveWebTextOverflow", () => {
  const box = (clientWidth: number, clientHeight: number, scrollWidth = clientWidth) => ({
    clientWidth,
    clientHeight,
    scrollWidth,
  });

  it("compares a single line's scroll width with its visible width", () => {
    expect(resolveWebTextOverflow(box(200, 20, 260), null)).toBe(true);
    expect(resolveWebTextOverflow(box(200, 20, 200), null)).toBe(false);
  });

  it("compares a clamped preview with its unbounded probe", () => {
    expect(resolveWebTextOverflow(box(200, 40), box(200, 80))).toBe(true);
    expect(resolveWebTextOverflow(box(200, 40), box(200, 40, 260))).toBe(true);
    expect(resolveWebTextOverflow(box(200, 40), box(200, 40))).toBe(false);
  });

  it("keeps the last decision while either element is hidden", () => {
    expect(resolveWebTextOverflow(box(0, 0), null)).toBeNull();
    expect(resolveWebTextOverflow(box(200, 40), box(0, 0))).toBeNull();
  });
});

vi.mock("@/constants/platform", () => ({ isWeb: false }));

/** Supply actual native line-layout output, independently of text length. */
function textLines(count: number): TextLayoutEvent {
  return {
    nativeEvent: {
      lines: Array.from({ length: count }, () => ({ width: 100, text: "rendered line" })),
    },
  } as TextLayoutEvent;
}

describe("native clamped text overflow", () => {
  it("does not disclose a short line, and detects actual wrapped lines", () => {
    const { result } = renderHook(() => useTextOverflow("measured content", 1));
    act(() => {
      result.current.onLayout(layoutEvent(240));
      result.current.onFullLayout?.(layoutEvent(240));
      result.current.onFullTextLayout(textLines(1));
    });
    expect(result.current.overflowing).toBe(false);
    act(() => {
      result.current.onFullLayout?.(layoutEvent(240, 96));
      result.current.onFullTextLayout(textLines(2));
    });
    expect(result.current.overflowing).toBe(true);
    act(() => {
      result.current.onFullLayout?.(layoutEvent(240));
      result.current.onFullTextLayout(textLines(1));
    });
    expect(result.current.overflowing).toBe(false);
  });
  it("fits the exact desktop boundary and updates when its line policy changes", () => {
    const { result, rerender } = renderHook(({ lines }) => useTextOverflow("same content", lines), {
      initialProps: { lines: 2 },
    });
    act(() => {
      result.current.onLayout(layoutEvent(180));
      result.current.onFullLayout?.(layoutEvent(180));
      result.current.onFullTextLayout(textLines(2));
    });
    expect(result.current.overflowing).toBe(false);
    rerender({ lines: 1 });
    act(() => result.current.onLayout(layoutEvent(180, 24)));
    expect(result.current.overflowing).toBe(true);
  });
  it("accepts full text layout arriving before visible layout", () => {
    const { result } = renderHook(() => useTextOverflow("full layout first", 1));
    act(() => {
      result.current.onFullLayout?.(layoutEvent(160, 144));
      result.current.onFullTextLayout(textLines(3));
    });
    expect(result.current.overflowing).toBe(false);
    act(() => result.current.onLayout(layoutEvent(160)));
    expect(result.current.overflowing).toBe(true);
  });
  it("preserves the last valid state while a retained pane has zero geometry", () => {
    const { result } = renderHook(() => useTextOverflow("retained prompt", 1));
    act(() => {
      result.current.onLayout(layoutEvent(160));
      result.current.onFullLayout?.(layoutEvent(160, 144));
      result.current.onFullTextLayout(textLines(3));
    });
    expect(result.current.overflowing).toBe(true);
    act(() => {
      result.current.onLayout(layoutEvent(0));
      result.current.onFullLayout?.(layoutEvent(0));
      result.current.onFullTextLayout(textLines(1));
    });
    expect(result.current.overflowing).toBe(true);
    act(() => {
      result.current.onLayout(layoutEvent(500));
      result.current.onFullLayout?.(layoutEvent(500));
    });
    expect(result.current.overflowing).toBe(false);
  });
  it("does not disclose a fitting message when native line reporting wraps it again", () => {
    const { result } = renderHook(() => useTextOverflow("I have WSL set to keep running", 1));
    act(() => {
      result.current.onLayout(layoutEvent(240, 24));
      // Native event handlers are optional on Text; the old probe had no layout handler.
      result.current.onFullLayout?.(layoutEvent(240, 24));
      result.current.onFullTextLayout(textLines(2));
    });
    expect(result.current.overflowing).toBe(false);
  });
});
