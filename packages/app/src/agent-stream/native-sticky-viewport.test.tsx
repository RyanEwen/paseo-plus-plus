// @vitest-environment jsdom

import { useNativeReadingRefresh } from "./native-sticky-viewport";
import {
  createNativeMeasuredHeaderIndex,
  resolveActualNativeReading,
} from "./native-actual-row-model";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamItem } from "@/types/stream";
import { stickyUser } from "./chat-outline/sticky-prompt.test-fixture";

interface NativeKeyboardEndpointHandlers {
  onStart(event: { height: number; progress: number }): void;
  onEnd(event: { height: number; progress: number }): void;
}
const endpointHarness = {
  handlers: null as NativeKeyboardEndpointHandlers | null,
  queue: [] as Array<() => void>,
};
function flushNativeEndpointQueue() {
  while (endpointHarness.queue.length) endpointHarness.queue.shift()!();
}
async function nativeEndpointReadingFixture() {
  vi.doMock("react-native-keyboard-controller", () => ({
    KeyboardController: { isVisible: () => false, state: () => ({ height: 0 }) },
    useGenericKeyboardHandler: (handlers: NativeKeyboardEndpointHandlers) => {
      endpointHarness.handlers = handlers;
    },
  }));
  vi.doMock("react-native-safe-area-context", () => ({
    useSafeAreaInsets: () => ({ bottom: 34, top: 0, left: 0, right: 0 }),
  }));
  vi.doMock("react-native-worklets", () => ({
    scheduleOnRN: (callback: (...args: unknown[]) => void, ...args: unknown[]) => {
      endpointHarness.queue.push(() => callback(...args));
    },
  }));
  const { usePublishDockReservation } =
    await import("@/keyboard/shift/internal/use-dock-reservation");
  let edge = 0;
  const items: StreamItem[] = [
    stickyUser("old", 1000),
    {
      id: "answer",
      kind: "assistant_message",
      text: "answer",
      timestamp: new Date(0),
      timelineCursor: { epoch: "epoch-1", seq: 1100 },
    },
    stickyUser("later", 1250),
  ];
  const geometry = new Map([
    ["old", { index: 0, y: 1000, height: 100 }],
    ["answer", { index: 1, y: 1100, height: 150 }],
    ["later", { index: 2, y: 1250, height: 53 }],
  ]);
  const mounted = new Set(items.map((item) => item.id));
  const readings: ReturnType<typeof resolveActualNativeReading>[] = [];
  const refresh = () =>
    readings.push(
      resolveActualNativeReading({
        items,
        geometry,
        headers: createNativeMeasuredHeaderIndex({ items, geometry }),
        mounted,
        offset: 1000,
        viewportHeight: 600,
        clippedLeading: edge,
        stickyEnabled: true,
      }),
    );
  const invalidate = vi.fn();
  const rendered = renderHook(() => {
    const snapshot = usePublishDockReservation(true, 0);
    useNativeReadingRefresh(snapshot, refresh, invalidate);
    return snapshot;
  });
  return {
    ...rendered,
    readings,
    invalidate,
    setEdge(value: number) {
      edge = value;
    },
    handlers: () => endpointHarness.handlers!,
  };
}
describe("native keyboard settlement reading refresh", () => {
  beforeEach(() => {
    endpointHarness.handlers = null;
    endpointHarness.queue = [];
  });
  afterEach(() => {
    vi.doUnmock("react-native-keyboard-controller");
    vi.doUnmock("react-native-safe-area-context");
    vi.doUnmock("react-native-worklets");
  });
  it("remeasures the final effective edge on end even when opening R is unchanged and no scroll/layout occurs", async () => {
    const fixture = await nativeEndpointReadingFixture();
    fixture.setEdge(100);
    act(() => {
      fixture.handlers().onStart({ height: 334, progress: 1 });
      flushNativeEndpointQueue();
    });
    expect(fixture.result.current).toEqual({ extent: 300, settledRevision: 0 });
    expect(fixture.readings.at(-1)?.rowId).toBe("answer");
    fixture.setEdge(300);
    act(() => {
      fixture.handlers().onEnd({ height: 334, progress: 1 });
      flushNativeEndpointQueue();
    });
    expect(fixture.result.current).toEqual({ extent: 300, settledRevision: 1 });
    expect(fixture.readings.map((reading) => reading.seq)).toEqual([1000, 1100, 1250]);
    expect(fixture.readings.at(-1)?.visibleUserIds).toEqual(["later"]);
    expect(fixture.invalidate).toHaveBeenCalledTimes(2);
    fixture.unmount();
  });
  it("refreshes once at closing completion and also publishes a cancelled zero-height completion", async () => {
    const fixture = await nativeEndpointReadingFixture();
    act(() => {
      fixture.handlers().onStart({ height: 334, progress: 1 });
      flushNativeEndpointQueue();
    });
    fixture.setEdge(300);
    act(() => {
      fixture.handlers().onEnd({ height: 334, progress: 1 });
      flushNativeEndpointQueue();
    });
    const openedCount = fixture.readings.length;
    act(() => {
      fixture.handlers().onStart({ height: 0, progress: 0 });
      flushNativeEndpointQueue();
    });
    expect(fixture.readings).toHaveLength(openedCount);
    fixture.setEdge(0);
    act(() => {
      fixture.handlers().onEnd({ height: 0, progress: 0 });
      flushNativeEndpointQueue();
    });
    expect(fixture.readings).toHaveLength(openedCount + 1);
    expect(fixture.result.current).toEqual({ extent: 0, settledRevision: 2 });
    act(() => {
      fixture.handlers().onStart({ height: 334, progress: 1 });
      flushNativeEndpointQueue();
    });
    act(() => {
      fixture.handlers().onEnd({ height: 0, progress: 0 });
      flushNativeEndpointQueue();
    });
    expect(fixture.result.current).toEqual({ extent: 0, settledRevision: 3 });
    expect(fixture.readings.at(-1)?.seq).toBe(1000);
    fixture.unmount();
  });
  it("does not refresh an unmounted consumer when queued native completion arrives", async () => {
    const fixture = await nativeEndpointReadingFixture();
    act(() => fixture.handlers().onEnd({ height: 334, progress: 1 }));
    const count = fixture.readings.length;
    fixture.unmount();
    act(flushNativeEndpointQueue);
    expect(fixture.readings).toHaveLength(count);
  });
});
