// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, renderHook } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NaturalMessageFlowContext,
  type MessageFlowContext,
  type UserMessageFlowProps,
  type useNaturalMessageMeasurements,
} from "./flow";
import { resolveMessageFlow, type NativeMessageMode } from "./flow-model";
import { UserMessageText } from "./text";
import { useNativeNaturalMeasurements } from "./native-flow";
import type { NativeMessagePresentationDriver } from "./native-presentation";

describe("native natural measurement revisions", () => {
  type Measurements = ReturnType<typeof useNaturalMessageMeasurements>;
  interface HookProps extends Pick<UserMessageFlowProps, "message" | "revision" | "controls"> {
    driver: Pick<NativeMessagePresentationDriver, "binding">;
  }

  /** Supply actual natural-frame reports, including the initially empty More
   * slot, before exercising a presentation-only or genuine geometry transition.
   */
  function seedNaturalMeasurements(current: () => Measurements) {
    act(() => current().setWidth(320));
    act(() => {
      const value = current();
      value.reportHeight("bodyHeight", 300);
      value.reportHeight("trailingHeight", 40);
      value.reportFrame("bubble", { x: 60, y: 0, width: 260, height: 300 });
      value.reportFrame("content", { x: 16, y: 16, width: 228, height: 268 });
      value.reportFrame("controls", { x: 0, y: 0, width: 0, height: 0 });
      value.reportFrame("text", { x: 0, y: 0, width: 228, height: 172 });
      value.reportText([
        { y: 0, height: 20, width: 200 },
        { y: 24, height: 20, width: 210 },
        { y: 48, height: 20, width: 180 },
      ]);
    });
  }

  const initialProps: HookProps = {
    message: "A full multiline prompt",
    revision: {},
    controls: null,
    driver: { binding: 17 },
  };

  it("retains the full natural extent when initial overflow discovery adds the More slot", () => {
    const { result, rerender } = renderHook(
      (props: HookProps) => useNativeNaturalMeasurements(props, 1),
      { initialProps },
    );
    seedNaturalMeasurements(() => result.current);
    const key = result.current.key;
    expect(
      resolveMessageFlow({ measurements: result.current.metrics, hasText: true })?.flowHeight,
    ).toBe(340);

    rerender({ ...initialProps, controls: React.createElement("span", null, "More") });

    expect(
      resolveMessageFlow({ measurements: result.current.metrics, hasText: true })?.flowHeight,
    ).toBe(340);
    expect(result.current.key === key).toBe(true);
    expect(result.current.metrics.bodyHeight).toBe(300);
  });

  it("retains natural measurements when only the same-binding driver object changes", () => {
    const { result, rerender } = renderHook(
      (props: HookProps) => useNativeNaturalMeasurements(props, 1),
      { initialProps },
    );
    seedNaturalMeasurements(() => result.current);
    const key = result.current.key;

    rerender({ ...initialProps, driver: { binding: 17 } });

    expect(
      resolveMessageFlow({ measurements: result.current.metrics, hasText: true })?.flowHeight,
    ).toBe(340);
    expect(result.current.key === key).toBe(true);
  });

  it.each(["content", "width", "font", "binding"])(
    "invalidates natural measurements for a genuine %s change",
    (change) => {
      const dimensions = { fontScale: 1 };
      const { result, rerender } = renderHook(
        (props: HookProps) => useNativeNaturalMeasurements(props, dimensions.fontScale),
        { initialProps },
      );
      seedNaturalMeasurements(() => result.current);
      const key = result.current.key;

      if (change === "width") {
        act(() => result.current.setWidth(280));
      } else if (change === "font") {
        dimensions.fontScale = 1.25;
        rerender(initialProps);
      } else if (change === "binding") {
        rerender({ ...initialProps, driver: { binding: 18 } });
      } else {
        rerender({ ...initialProps, message: "A changed prompt", revision: {} });
      }

      expect(result.current.key === key).toBe(false);
      expect(result.current.metrics.bodyHeight).toBeNull();
      expect(
        resolveMessageFlow({ measurements: result.current.metrics, hasText: true }),
      ).toBeNull();
    },
  );
});

/** The unit project renders the .web text preview, which observes its text's size. */
class InertResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe("native pinned prompt press", () => {
  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("ResizeObserver", InertResizeObserver);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  /** The Android sticky flow, with its presentation shared value in `mode`. */
  function nativeStickyFlow(mode: NativeMessageMode): MessageFlowContext {
    const driver = {
      binding: 1,
      presentation: { value: { mode, prefixHeight: 20 } },
    } as unknown as NativeMessagePresentationDriver;
    return {
      adapter: "nativeSticky",
      driver,
      compact: false,
      bubbleWidth: undefined,
      textWidth: undefined,
      textClipWidth: undefined,
      textPrefixHeight: undefined,
      textTranslateX: 0,
      textTranslateY: 0,
      register() {},
      reportFrame() {},
      reportText() {},
    };
  }

  /** Press the message text itself, which sits above the bubble's press target. */
  function pressText(mode: NativeMessageMode) {
    const flow = nativeStickyFlow(mode);
    const onContentPress = vi.fn();
    const view = render(
      <NaturalMessageFlowContext.Provider value={flow}>
        <UserMessageText
          message="Pinned prompt"
          hasText
          onContentPress={onContentPress}
          contentAccessibilityLabel="Go to message"
        />
      </NaturalMessageFlowContext.Provider>,
    );
    fireEvent.click(view.getByTestId("user-message-text"));
    return onContentPress;
  }

  it.each(["compact", "expanded"] as const)(
    "returns to the message when its %s pinned text is tapped",
    (mode) => {
      expect(pressText(mode)).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps ordinary message text inert", () => {
    expect(pressText("ordinary")).not.toHaveBeenCalled();
  });
});
