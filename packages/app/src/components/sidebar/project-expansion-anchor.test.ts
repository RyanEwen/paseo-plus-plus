import { describe, expect, it, vi } from "vitest";
import { anchorProjectExpansion, type ProjectExpansionFollowing } from "./project-expansion-anchor";

describe("accordion expansion scroll anchoring", () => {
  function scenario(duration = 100) {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    let layoutTop = 900;
    let transitionProgress: number | undefined;
    let offset = 600;
    let maxOffset = Infinity;
    let cancelled: ProjectExpansionFollowing | undefined;
    const scrolls: number[] = [];
    const toggle = vi.fn();
    const begin = () => {
      cancelled = anchorProjectExpansion({
        duration,
        toggle,
        measure: (receive) =>
          receive({ headerTop: 40 + layoutTop - offset, viewportTop: 40, transitionProgress }),
        scrollBy: (delta) => {
          offset = Math.min(maxOffset, Math.max(0, offset + delta));
          scrolls.push(offset);
        },
        requestFrame: (callback) => {
          frames.set(++nextFrame, callback);
          return nextFrame;
        },
        cancelFrame: (id) => {
          if (typeof id === "number") {
            frames.delete(id);
          }
        },
      });
    };
    const frame = (time: number, top: number, maxScroll = Infinity, paintedProgress?: number) => {
      layoutTop = top;
      transitionProgress = paintedProgress;
      maxOffset = maxScroll;
      offset = Math.min(offset, maxOffset);
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((callback) => callback(time));
    };
    return {
      begin,
      frame,
      toggle,
      scrolls,
      frames,
      cancel: () => cancelled?.cancel(),
      top: () => layoutTop - offset,
    };
  }

  it("brings the clicked project to the viewport top through the collapse without scrolling to list start", () => {
    const run = scenario();
    run.begin();
    expect(run.toggle).toHaveBeenCalledTimes(1);
    run.frame(0, 900);
    run.frame(25, 800);
    expect(run.top()).toBe(225);
    run.frame(50, 600);
    expect(run.top()).toBe(150);
    run.frame(100, 350);
    expect(run.top()).toBe(0);
    expect(run.scrolls).toEqual([575, 450, 350]);
    expect(run.frames.size).toBe(0);
  });

  it("follows a painted transition that starts after the first animation frame", () => {
    const run = scenario();
    run.begin();
    run.frame(0, 900, Infinity, 0);
    run.frame(100, 600, Infinity, 0.5);
    expect(run.top()).toBe(150);
    expect(run.frames.size).toBe(1);
    run.frame(150, 350, Infinity, 1);
    expect(run.top()).toBe(0);
    expect(run.frames.size).toBe(0);
  });

  it("aligns the selected header immediately when reduced motion disables animation", () => {
    const run = scenario(0);
    run.begin();
    run.frame(0, 100);
    expect(run.scrolls).toEqual([100]);
    expect(run.top()).toBe(0);
    expect(run.frames.size).toBe(0);
  });

  it("retains a visible header when the content end prevents top alignment", () => {
    const run = scenario(0);
    run.begin();
    run.frame(0, 350, 120);
    expect(run.scrolls).toEqual([120]);
    expect(run.top()).toBe(230);
    expect(run.frames.size).toBe(0);
  });

  it("releases scrolling when the user takes over or the scroll owner unmounts", () => {
    const run = scenario();
    run.begin();
    run.frame(0, 900);
    run.frame(25, 800);
    run.cancel();
    run.frame(50, 600);
    expect(run.scrolls).toEqual([575]);
    expect(run.frames.size).toBe(0);
  });

  it("keeps an accepted expansion when manual input cancels a delayed native measurement", () => {
    let receive: ((value: { headerTop: number; viewportTop: number } | null) => void) | undefined;
    const toggle = vi.fn();
    const scrollBy = vi.fn();
    const following = anchorProjectExpansion({
      duration: 100,
      toggle,
      scrollBy,
      measure: (callback) => {
        receive = callback;
      },
    });
    following.cancel();
    expect(toggle).toHaveBeenCalledTimes(1);
    receive?.({ headerTop: 300, viewportTop: 0 });
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("discards a delayed expansion only when its owner has unmounted", () => {
    let receive: ((value: { headerTop: number; viewportTop: number } | null) => void) | undefined;
    const toggle = vi.fn();
    const following = anchorProjectExpansion({
      duration: 100,
      toggle,
      scrollBy: vi.fn(),
      measure: (callback) => {
        receive = callback;
      },
    });
    following.dispose();
    receive?.({ headerTop: 300, viewportTop: 0 });
    following.cancel();
    expect(toggle).not.toHaveBeenCalled();
  });

  it("preserves click order when an older native measurement finishes after the next selection", () => {
    let first: ((value: { headerTop: number; viewportTop: number } | null) => void) | undefined;
    let second: ((value: { headerTop: number; viewportTop: number } | null) => void) | undefined;
    const toggles: string[] = [];
    const older = anchorProjectExpansion({
      duration: 100,
      toggle: () => {
        toggles.push("first");
      },
      scrollBy: vi.fn(),
      measure: (callback) => {
        first = callback;
      },
    });
    older.cancel();
    const newer = anchorProjectExpansion({
      duration: 100,
      toggle: () => {
        toggles.push("second");
      },
      scrollBy: vi.fn(),
      measure: (callback) => {
        second = callback;
      },
      requestFrame: () => 1,
      cancelFrame: () => {},
    });
    second?.({ headerTop: 300, viewportTop: 0 });
    first?.({ headerTop: 300, viewportTop: 0 });
    expect(toggles).toEqual(["first", "second"]);
    newer.dispose();
  });
});
