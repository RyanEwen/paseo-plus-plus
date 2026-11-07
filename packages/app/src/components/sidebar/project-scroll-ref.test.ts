import { describe, expect, it, vi } from "vitest";
import { createProjectScrollRef } from "./project-scroll-ref";

describe("createProjectScrollRef", () => {
  it("retains native nested-list measurement and autoscroll access on the React callback ref", () => {
    const node = { scrollTo: vi.fn() };
    const animated = Object.assign(
      (value: typeof node | null) => {
        if (value) animated.current = value;
        return value;
      },
      { current: null as typeof node | null },
    );
    const forwarded = createProjectScrollRef(animated);
    expect(forwarded(node)).toBeUndefined();
    expect(forwarded.current).toBe(node);
    forwarded.current?.scrollTo({ y: 40, animated: false });
    expect(node.scrollTo).toHaveBeenCalledWith({ y: 40, animated: false });
    forwarded(null);
    expect(forwarded.current).toBeNull();
    expect(animated.current).toBe(node);
  });
});
