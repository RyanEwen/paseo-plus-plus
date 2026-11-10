// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWebMessageMeasurements } from "./flow-measurements.web";

/** Observes nothing; the tests drive reads through the hook's own report callbacks. */
class InertResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** A rail whose measured width comes from `widths`, one value per read, the last repeating. */
function railWithWidths(widths: readonly number[]): HTMLDivElement {
  const rail = document.createElement("div");
  let reads = 0;
  rail.getBoundingClientRect = () => {
    const width = widths[Math.min(reads, widths.length - 1)]!;
    reads += 1;
    return { width, height: 0, top: 0, left: 0, right: width, bottom: 0 } as DOMRect;
  };
  return rail;
}

function renderMeasurements(rail: HTMLDivElement) {
  const revision = {};
  const view = renderHook(() =>
    useWebMessageMeasurements({ revision, bounded: false, compact: false, controls: null }),
  );
  view.result.current.rail.current = rail;
  return view;
}

describe("web message measurement convergence", () => {
  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("ResizeObserver", InertResizeObserver);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("settles when the rail width alternates as each re-bind changes layout", () => {
    // A scrollbar that appears for one width and disappears for the other.
    const alternating = Array.from({ length: 200 }, (_, read) => (read % 2 === 0 ? 300 : 315));
    const view = renderMeasurements(railWithWidths(alternating));
    expect(() => act(() => view.result.current.reportFrame())).not.toThrow();
    expect([300, 315]).toContain(view.result.current.width);
  });

  it("ignores sub-pixel rail jitter instead of re-binding", () => {
    const view = renderMeasurements(railWithWidths([300, 300.4, 299.7, 300.2]));
    act(() => view.result.current.reportFrame());
    expect(view.result.current.width).toBe(300);
    act(() => view.result.current.reportFrame());
    act(() => view.result.current.reportFrame());
    expect(view.result.current.width).toBe(300);
  });
});
