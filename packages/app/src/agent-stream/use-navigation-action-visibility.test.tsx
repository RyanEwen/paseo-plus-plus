// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useNavigationActionVisibility } from "./use-navigation-action-visibility";

vi.mock("@/constants/platform", () => ({ isWeb: true }));

function mousePointer(type: "pointerdown" | "pointermove", x: number, y: number) {
  const event = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true });
  Object.defineProperty(event, "pointerType", { value: "mouse" });
  document.dispatchEvent(event);
}

function renderVisibility(enabled = true, epoch: string | null = "epoch-1") {
  return renderHook(
    ({ enabled: on, epoch: current }) => useNavigationActionVisibility(on, current),
    { initialProps: { enabled, epoch } },
  );
}

describe("useNavigationActionVisibility", () => {
  it("holds the arrow destination until the mouse really moves", () => {
    const { result } = renderVisibility();
    act(() => mousePointer("pointerdown", 10, 10));
    act(() => result.current.start("target"));
    expect(result.current.key).toBe("target");

    act(() => mousePointer("pointermove", 10, 10));
    expect(result.current.key).toBe("target");

    act(() => mousePointer("pointermove", 11, 10));
    expect(result.current.key).toBeNull();
  });

  it("clears on manual keyboard or wheel input", () => {
    const { result } = renderVisibility();
    act(() => result.current.start("target"));
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
    });
    expect(result.current.key).toBeNull();

    act(() => result.current.start("target"));
    act(() => {
      document.dispatchEvent(new WheelEvent("wheel", { deltaY: -10 }));
    });
    expect(result.current.key).toBeNull();
  });

  it("never restores a hold that was already cleared when discovery retargets late", () => {
    const { result } = renderVisibility();
    act(() => result.current.start("discover-previous"));
    act(() => result.current.retarget("found"));
    expect(result.current.key).toBe("found");

    act(() => result.current.clear());
    act(() => result.current.retarget("late"));
    expect(result.current.key).toBeNull();
  });

  it("drops the hold on epoch replacement and while disabled", () => {
    const { result, rerender } = renderVisibility();
    act(() => result.current.start("target"));

    rerender({ enabled: true, epoch: "epoch-2" });
    expect(result.current.key).toBeNull();

    rerender({ enabled: false, epoch: "epoch-2" });
    act(() => result.current.start("target"));
    expect(result.current.key).toBeNull();
  });
});
