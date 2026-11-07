/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { subscribeAncestorScroll, type FrameScheduler } from "./ancestor-scroll";

/** Run queued frames only when the test asks, so coalescing is observable. */
function manualFrames() {
  let next = 1;
  const pending = new Map<number, () => void>();
  const scheduler: FrameScheduler = {
    request: (callback) => {
      const handle = next++;
      pending.set(handle, callback);
      return handle;
    },
    cancel: (handle) => {
      pending.delete(handle);
    },
  };
  const flush = () => {
    const callbacks = [...pending.values()];
    pending.clear();
    for (const callback of callbacks) callback();
  };
  return { scheduler, flush, pendingCount: () => pending.size };
}

function scrollEvent(): Event {
  return new Event("scroll", { bubbles: false });
}

describe("subscribeAncestorScroll", () => {
  const unsubscribes: Array<() => void> = [];

  afterEach(() => {
    for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
    document.body.replaceChildren();
  });

  function mount() {
    const ancestor = document.createElement("div");
    const host = document.createElement("div");
    const unrelated = document.createElement("div");
    ancestor.append(host);
    document.body.append(ancestor, unrelated);
    const frames = manualFrames();
    let updates = 0;
    unsubscribes.push(
      subscribeAncestorScroll({
        host,
        update: () => {
          updates++;
        },
        scheduler: frames.scheduler,
      }),
    );
    return { ancestor, unrelated, frames, updates: () => updates };
  }

  it("coalesces scrolls that move the host into one update per frame", () => {
    const view = mount();
    document.dispatchEvent(scrollEvent());
    view.ancestor.dispatchEvent(scrollEvent());
    document.dispatchEvent(scrollEvent());

    expect(view.updates()).toBe(0);
    view.frames.flush();
    expect(view.updates()).toBe(1);

    view.ancestor.dispatchEvent(scrollEvent());
    view.frames.flush();
    expect(view.updates()).toBe(2);
  });

  it("ignores scrolling inside unrelated elements", () => {
    const view = mount();
    view.unrelated.dispatchEvent(scrollEvent());
    expect(view.frames.pendingCount()).toBe(0);
    view.frames.flush();
    expect(view.updates()).toBe(0);
  });

  it("cancels a pending update and stops listening when unsubscribed", () => {
    const view = mount();
    document.dispatchEvent(scrollEvent());
    expect(view.frames.pendingCount()).toBe(1);

    unsubscribes.splice(0).forEach((unsubscribe) => unsubscribe());
    expect(view.frames.pendingCount()).toBe(0);
    document.dispatchEvent(scrollEvent());
    view.frames.flush();
    expect(view.updates()).toBe(0);
  });
});
