import {
  anchorProjectExpansion,
  createProjectScrollRef,
  type ProjectExpansionFollowing,
} from "./sidebar/project-expansion-anchor";
/**
 * @vitest-environment jsdom
 */
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import { useDragReorderState, type DragReorderState } from "./drag-reorder/use-drag-reorder-state";
import type { DragReorderMove } from "./drag-reorder/reorder-items";
import React, { memo } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DraggableListDragHandleProps } from "./draggable-list.types";
import { DraggableList, type DraggableRenderItemInfo } from "./draggable-list.web";

interface Item {
  id: string;
}

const items: Item[] = [{ id: "one" }];

function keyExtractor(item: Item): string {
  return item.id;
}

function onDragEnd() {}

let root: Root | null = null;
let container: HTMLElement | null = null;
let rowRenderCount = 0;

const Row = memo(function Row({
  dragHandleProps: _dragHandleProps,
}: {
  dragHandleProps?: DraggableListDragHandleProps;
}) {
  rowRenderCount += 1;
  return <div>row</div>;
});

function renderRow(info: DraggableRenderItemInfo<Item>) {
  return <Row dragHandleProps={info.dragHandleProps} />;
}

function renderOwnedRow() {
  return <div data-testid="owned-row">row</div>;
}

function renderReplacementRow(info: DraggableRenderItemInfo<Item>) {
  return <Row dragHandleProps={info.dragHandleProps} />;
}

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  rowRenderCount = 0;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

describe("DraggableList web row stability", () => {
  it.each([false, true])(
    "forwards list testID exactly once (scrollEnabled=%s)",
    (scrollEnabled) => {
      const render = () =>
        act(() => {
          root?.render(
            <DraggableList
              testID="owned-list"
              scrollEnabled={scrollEnabled}
              data={items}
              keyExtractor={keyExtractor}
              renderItem={renderOwnedRow}
              onDragEnd={onDragEnd}
            />,
          );
        });
      render();
      expect(container!.querySelectorAll('[data-testid="owned-list"]')).toHaveLength(1);
      const list = container!.querySelector('[data-testid="owned-list"]')!;
      const row = container!.querySelector('[data-testid="owned-row"]')!;
      expect(list.contains(row)).toBe(true);
      render();
      expect(container!.querySelectorAll('[data-testid="owned-list"]')).toHaveLength(1);
      expect(container!.querySelector('[data-testid="owned-list"]')).toBe(list);
      expect(container!.querySelector('[data-testid="owned-row"]')).toBe(row);
    },
  );

  it("keeps drag handle props stable when the render callback changes", () => {
    act(() => {
      root?.render(
        <DraggableList
          data={items}
          keyExtractor={keyExtractor}
          renderItem={renderRow}
          onDragEnd={onDragEnd}
          useDragHandle
        />,
      );
    });
    expect(rowRenderCount).toBe(1);

    act(() => {
      root?.render(
        <DraggableList
          data={items}
          keyExtractor={keyExtractor}
          renderItem={renderReplacementRow}
          onDragEnd={onDragEnd}
          useDragHandle
        />,
      );
    });

    expect(rowRenderCount).toBe(1);
  });
});

let rowActionClicks = 0;
function handleRowActionClick() {
  rowActionClicks += 1;
}
function renderActionRow(info: DraggableRenderItemInfo<Item>) {
  return (
    <div {...info.dragHandleProps?.attributes} {...info.dragHandleProps?.listeners}>
      <button type="button" onClick={handleRowActionClick}>
        Workspace actions
      </button>
    </div>
  );
}

it.each([false, true])(
  "keeps row actions enabled when dragging is disabled (handle=%s)",
  (useDragHandle) => {
    rowActionClicks = 0;
    act(() =>
      root?.render(
        <DraggableList
          disabled
          data={items}
          keyExtractor={keyExtractor}
          renderItem={renderActionRow}
          onDragEnd={onDragEnd}
          useDragHandle={useDragHandle}
        />,
      ),
    );
    const button = container!.querySelector("button")!;
    expect(button.closest('[aria-disabled="true"]')).toBeNull();
    act(() => button.click());
    expect(rowActionClicks).toBe(1);
  },
);

let dragModel: DragReorderState<Item> | null = null;
function DragStateHarness({
  data,
  dropped,
  disabled = false,
}: {
  data: Item[];
  dropped: (items: Item[], move?: DragReorderMove) => void;
  disabled?: boolean;
}) {
  dragModel = useDragReorderState({ data, keyExtractor, onDragEnd: dropped, disabled });
  return null;
}

describe("drag result identity", () => {
  it("passes actual active/from/to/anchor from the drag snapshot even if rendered data changes", () => {
    const dropped = vi.fn();
    const original = [{ id: "one" }, { id: "two" }, { id: "three" }];
    act(() => root?.render(<DragStateHarness data={original} dropped={dropped} />));
    act(() => dragModel!.handlers.onDragStart({ active: { id: "one" } } as DragStartEvent));
    act(() =>
      root?.render(<DragStateHarness data={[{ id: "new" }, ...original]} dropped={dropped} />),
    );
    act(() =>
      dragModel!.handlers.onDragEnd({
        active: { id: "one" },
        over: { id: "three" },
      } as DragEndEvent),
    );
    expect(dropped).toHaveBeenCalledExactlyOnceWith([original[1], original[2], original[0]], {
      activeKey: "one",
      overKey: "three",
      from: 0,
      to: 2,
    });
  });
  it("does not emit an order or move for a cancelled drop", () => {
    const dropped = vi.fn();
    act(() => root?.render(<DragStateHarness data={items} dropped={dropped} />));
    act(() => dragModel!.handlers.onDragStart({ active: { id: "one" } } as DragStartEvent));
    act(() => dragModel!.handlers.onDragEnd({ active: { id: "one" }, over: null } as DragEndEvent));
    expect(dropped).not.toHaveBeenCalled();
  });
});

it("does not begin or finish a reorder when the list is disabled", () => {
  const dropped = vi.fn();
  const data = [{ id: "one" }, { id: "two" }];
  act(() => root?.render(<DragStateHarness data={data} dropped={dropped} disabled />));
  act(() => dragModel!.handlers.onDragStart({ active: { id: "one" } } as DragStartEvent));
  expect(dragModel!.activeId).toBeNull();
  act(() =>
    dragModel!.handlers.onDragEnd({ active: { id: "one" }, over: { id: "two" } } as DragEndEvent),
  );
  expect(dropped).not.toHaveBeenCalled();
});

it("animates unchanged rows when surrounding groups collapse or expand and respects disabled motion", () => {
  let top = 0;
  const cancel = vi.fn();
  const animate = vi.fn(() => ({ cancel }));
  const properties = ["offsetTop", "offsetWidth", "getClientRects", "animate"] as const;
  const descriptors = properties.map((key) =>
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, key),
  );
  Object.defineProperty(HTMLElement.prototype, "offsetTop", {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute("data-position-transition") ? top : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => 100,
  });
  Object.defineProperty(HTMLElement.prototype, "getClientRects", {
    configurable: true,
    value: () => [{ width: 100, height: 20 }],
  });
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
  const render = (revision: boolean, duration = 100) => (
    <DraggableList
      data={items}
      keyExtractor={keyExtractor}
      renderItem={renderRow}
      onDragEnd={onDragEnd}
      positionTransitionDuration={duration}
      positionTransitionRevision={revision}
    />
  );
  try {
    act(() => root?.render(render(false)));
    const node = container!.querySelector<HTMLElement>("[data-position-transition]")!;
    node.style.transform = "none";
    // Stable hydrated membership establishes the motion policy without moving a row.
    act(() => root?.render(render(false)));
    expect(animate).not.toHaveBeenCalled();
    top = -80;
    act(() => root?.render(render(true)));
    expect(animate).toHaveBeenLastCalledWith(
      [{ transform: "translateY(80px)" }, { transform: "translateY(0px)" }],
      { duration: 100, easing: "ease-in-out" },
    );
    top = 0;
    act(() => root?.render(render(false)));
    expect(animate).toHaveBeenLastCalledWith(
      [{ transform: "translateY(-80px)" }, { transform: "translateY(0px)" }],
      { duration: 100, easing: "ease-in-out" },
    );
    expect(cancel).toHaveBeenCalledTimes(1);
    top = 200;
    act(() => root?.render(render(true, 0)));
    expect(animate).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(container!.querySelector("[data-position-transition]")).toBe(node);
  } finally {
    properties.forEach((key, index) => {
      const descriptor = descriptors[index];
      if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, key);
    });
  }
});

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
