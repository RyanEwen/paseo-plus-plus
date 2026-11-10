/**
 * @vitest-environment jsdom
 */
import { renderHook } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLayoutUpdateBudget } from "./use-layout-update-budget";

/** Spends the budget `count` times in one synchronous chain and returns each result. */
function spendInOneChain(spend: () => boolean, count: number): boolean[] {
  return Array.from({ length: count }, () => spend());
}

/** Lets the current synchronous chain end, as it does between two browser events. */
async function endChain(): Promise<void> {
  await Promise.resolve();
}

describe("useLayoutUpdateBudget", () => {
  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("cuts off a synchronous chain and retries it once on the next frame", () => {
    const retry = vi.fn();
    const { result } = renderHook(() => useLayoutUpdateBudget(retry));

    expect(spendInOneChain(result.current, 5)).toEqual([true, true, true, false, false]);
    expect(retry).not.toHaveBeenCalled();

    vi.advanceTimersToNextFrame();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("gives separate events in one slow frame their own budget", async () => {
    const retry = vi.fn();
    const { result } = renderHook(() => useLayoutUpdateBudget(retry));

    // Several scroll events can land before the next animation frame. Each is its own
    // chain, so none of them is deferred.
    for (let event = 0; event < 4; event += 1) {
      expect(spendInOneChain(result.current, 3)).toEqual([true, true, true]);
      await endChain();
    }
    vi.advanceTimersToNextFrame();
    expect(retry).not.toHaveBeenCalled();
  });
});
