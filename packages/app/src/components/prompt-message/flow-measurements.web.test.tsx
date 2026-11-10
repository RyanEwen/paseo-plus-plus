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

/**
 * The measured nodes of an ordinary preview whose text reports a different line height on
 * every read, so its font key never matches the previous measurement.
 */
function measuredNodes() {
  const make = (height: number) => {
    const node = document.createElement("div");
    node.getBoundingClientRect = () =>
      ({ width: 300, height, top: 0, left: 0, right: 300, bottom: height }) as DOMRect;
    return node;
  };
  const body = make(60);
  const trailing = make(24);
  const bubble = make(60);
  const content = make(40);
  const textFrame = make(20);
  const controls = make(24);
  const text = document.createElement("span");
  text.dataset.testid = "user-message-text";
  let reads = 0;
  text.getBoundingClientRect = () => {
    reads += 1;
    text.style.lineHeight = `${20 + (reads % 2)}px`;
    return { width: 200, height: 20, top: 0, left: 0, right: 200, bottom: 20 } as DOMRect;
  };
  content.append(text);
  return {
    body,
    trailing,
    frames: new Map<"bubble" | "content" | "text" | "controls", HTMLElement>([
      ["bubble", bubble],
      ["content", content],
      ["text", textFrame],
      ["controls", controls],
    ]),
  };
}

function renderMeasurements(
  rail: HTMLDivElement,
  bodyPresentation: "actualPrompt" | "ordinaryPreview" = "actualPrompt",
) {
  const revision = {};
  const view = renderHook(() =>
    useWebMessageMeasurements({
      revision,
      bounded: false,
      compact: false,
      controls: null,
      bodyPresentation,
    }),
  );
  view.result.current.rail.current = rail;
  return view;
}

/** Report one measurement frame, the way the layout effect does. */
function reportFrame(view: ReturnType<typeof renderMeasurements>): void {
  act(() => view.result.current.reportFrame());
}

describe("web message measurement convergence", () => {
  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("ResizeObserver", InertResizeObserver);
    // jsdom has no Range layout; the measured text reports no line boxes.
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [],
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(Range.prototype, "getClientRects");
  });

  it("settles when the rail width alternates as each re-bind changes layout", () => {
    // A scrollbar that appears for one width and disappears for the other.
    const alternating = Array.from({ length: 200 }, (_, read) => (read % 2 === 0 ? 300 : 315));
    const view = renderMeasurements(railWithWidths(alternating));
    expect(() => reportFrame(view)).not.toThrow();
    expect([300, 315]).toContain(view.result.current.width);
  });

  it("never exceeds React's update depth when the rail cycles through three widths", () => {
    const cycling = Array.from({ length: 300 }, (_, read) => [300, 315, 330][read % 3]!);
    const view = renderMeasurements(railWithWidths(cycling));
    expect(() => act(() => view.result.current.reportFrame())).not.toThrow();
    expect([300, 315, 330]).toContain(view.result.current.width);
  });

  it("never exceeds React's update depth when the measured font never matches", () => {
    const view = renderMeasurements(railWithWidths([300]), "ordinaryPreview");
    const nodes = measuredNodes();
    act(() => {
      view.result.current.body.current = nodes.body;
      view.result.current.trailing.current = nodes.trailing;
      for (const [name, node] of nodes.frames) view.result.current.register(name, node as never);
    });
    expect(() => act(() => view.result.current.reportFrame())).not.toThrow();
  });

  it("never exceeds React's update depth when many cycling rows mount together", () => {
    const rows = Array.from({ length: 40 }, (_, row) =>
      railWithWidths(Array.from({ length: 300 }, (_, read) => 300 + ((read + row) % 3) * 15)),
    );
    const revision = {};
    const view = renderHook(() =>
      rows.map(() =>
        useWebMessageMeasurements({ revision, bounded: false, compact: false, controls: null }),
      ),
    );
    view.result.current.forEach((measurements, index) => {
      measurements.rail.current = rows[index]!;
    });
    expect(() =>
      act(() => {
        for (const measurements of view.result.current) measurements.reportFrame();
      }),
    ).not.toThrow();
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
