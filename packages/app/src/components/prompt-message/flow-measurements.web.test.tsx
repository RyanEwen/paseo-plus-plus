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

/** `reads` rail widths cycling through `widths`, starting `offset` steps in. */
function cyclingWidths(widths: readonly number[], reads: number, offset = 0): number[] {
  return Array.from({ length: reads }, (_, read) => widths[(read + offset) % widths.length]!);
}

/** Give an ordinary preview the nodes it measures. */
function attachMeasuredNodes(view: ReturnType<typeof renderMeasurements>): void {
  const nodes = measuredNodes();
  const measurements = view.result.current;
  act(() => {
    measurements.body.current = nodes.body;
    measurements.trailing.current = nodes.trailing;
    for (const [name, node] of nodes.frames) measurements.register(name, node as never);
  });
}

/** Mount one measurement hook per rail, all sharing one content revision. */
function renderRows(rails: readonly HTMLDivElement[]) {
  const revision = {};
  const view = renderHook(() =>
    rails.map(() =>
      useWebMessageMeasurements({ revision, bounded: false, compact: false, controls: null }),
    ),
  );
  for (const [index, measurements] of view.result.current.entries()) {
    measurements.rail.current = rails[index]!;
  }
  return view;
}

/** Report a frame for every row inside one act, as rows mounting together do. */
function reportEveryFrame(view: ReturnType<typeof renderRows>): void {
  act(() => {
    for (const measurements of view.result.current) measurements.reportFrame();
  });
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
    const view = renderMeasurements(railWithWidths(cyclingWidths([300, 315], 200)));
    expect(() => reportFrame(view)).not.toThrow();
    expect([300, 315]).toContain(view.result.current.width);
  });

  it("never exceeds React's update depth when the rail cycles through three widths", () => {
    const view = renderMeasurements(railWithWidths(cyclingWidths([300, 315, 330], 300)));
    expect(() => reportFrame(view)).not.toThrow();
    expect([300, 315, 330]).toContain(view.result.current.width);
  });

  it("never exceeds React's update depth when the measured font never matches", () => {
    const view = renderMeasurements(railWithWidths([300]), "ordinaryPreview");
    attachMeasuredNodes(view);
    expect(() => reportFrame(view)).not.toThrow();
  });

  it("never exceeds React's update depth when many cycling rows mount together", () => {
    const rails = Array.from({ length: 40 }, (_, row) =>
      railWithWidths(cyclingWidths([300, 315, 330], 300, row)),
    );
    const view = renderRows(rails);
    expect(() => reportEveryFrame(view)).not.toThrow();
  });

  it("ignores sub-pixel rail jitter instead of re-binding", () => {
    const view = renderMeasurements(railWithWidths([300, 300.4, 299.7, 300.2]));
    reportFrame(view);
    expect(view.result.current.width).toBe(300);
    reportFrame(view);
    reportFrame(view);
    expect(view.result.current.width).toBe(300);
  });
});
