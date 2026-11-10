// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PromptRowBoundary } from "./prompt-row-boundary";

function Throwing(): React.ReactNode {
  throw new Error("sticky rendering failed");
}

/** A layout effect that sets new state on every commit, like a measurement loop. */
function MeasurementLoop() {
  const [count, setCount] = React.useState(0);
  React.useLayoutEffect(() => setCount((value) => value + 1));
  return <span>{count}</span>;
}

const PLAIN = <span data-testid="plain-message">Plain prompt</span>;

describe("PromptRowBoundary", () => {
  beforeEach(() => {
    vi.stubGlobal("React", React);
    // React reports caught errors to the console as well; keep the test output quiet.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows the plain message when the sticky row throws, and logs once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const view = render(
      <PromptRowBoundary fallback={PLAIN}>
        <Throwing />
      </PromptRowBoundary>,
    );
    expect(view.getByTestId("plain-message")).toBeTruthy();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("contains React's update-depth error from a measurement loop to its row", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const view = render(
      <div>
        <PromptRowBoundary fallback={PLAIN}>
          <MeasurementLoop />
        </PromptRowBoundary>
        <span data-testid="next-row">Next row</span>
      </div>,
    );
    expect(view.getByTestId("plain-message")).toBeTruthy();
    expect(view.getByTestId("next-row")).toBeTruthy();
  });
});
