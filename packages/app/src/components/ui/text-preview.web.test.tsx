// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TextPreview } from "./text-preview";

class InertResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** Make every text element report a height that flips between one and two lines. */
function flipMeasuredHeight() {
  let reads = 0;
  return vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => {
    reads += 1;
    const height = reads % 2 === 1 ? 40 : 20;
    return { width: 200, height, top: 0, left: 0, right: 200, bottom: height } as DOMRect;
  });
}

/**
 * A caller whose layout follows the preview's overflow: each change re-renders the preview
 * with a fresh style object, as callers that build styles inline do.
 */
function OverflowFollower({ onReport }: { onReport: () => void }) {
  const [overflowing, setOverflowing] = React.useState(false);
  const report = React.useCallback(
    (next: boolean) => {
      onReport();
      setOverflowing(next);
    },
    [onReport],
  );
  const style = { lineHeight: 20, opacity: overflowing ? 1 : 0.99 };
  return (
    <TextPreview numberOfLines={1} onOverflowChange={report} style={style}>
      Prompt text that flips between one and two lines as its own layout changes
    </TextPreview>
  );
}

describe("TextPreview measurement convergence", () => {
  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("ResizeObserver", InertResizeObserver);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("stops re-measuring when its overflow flips its own layout", () => {
    flipMeasuredHeight();
    const onReport = vi.fn();
    expect(() => render(<OverflowFollower onReport={onReport} />)).not.toThrow();
    // The flip is detected and held instead of reported for every layout pass.
    expect(onReport.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it("re-measures for a style change, not for each fresh style object", () => {
    const measured = flipMeasuredHeight();
    const view = render(
      <TextPreview numberOfLines={1} onOverflowChange={vi.fn()} style={{ lineHeight: 20 }}>
        Stable prompt
      </TextPreview>,
    );
    const reads = measured.mock.calls.length;
    act(() =>
      view.rerender(
        <TextPreview numberOfLines={1} onOverflowChange={vi.fn()} style={{ lineHeight: 20 }}>
          Stable prompt
        </TextPreview>,
      ),
    );
    expect(measured.mock.calls.length).toBe(reads);
  });
});
