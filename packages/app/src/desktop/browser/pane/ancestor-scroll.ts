/** Schedules work for the next animation frame; injectable so tests control frame timing. */
export interface FrameScheduler {
  request(callback: () => void): number;
  cancel(handle: number): void;
}

const animationFrames: FrameScheduler = {
  request: (callback) => window.requestAnimationFrame(callback),
  cancel: (handle) => window.cancelAnimationFrame(handle),
};

/** True when scrolling `target` can move `host`: the document itself or one of its ancestors. */
function scrollMovesHost(target: EventTarget | null, host: Node): boolean {
  if (target instanceof Document) {
    return true;
  }
  return target instanceof Node && target.contains(host);
}

/**
 * Re-run `update` after any scroll that can move `host`, at most once per animation frame.
 *
 * Scroll events do not bubble, so this listens in the capture phase on the document. Scrolls in
 * unrelated scrollers (such as the agent stream) cannot move the host and are ignored, which
 * keeps the browser's layout read and style writes off that hot path.
 *
 * @returns An unsubscribe function that also cancels a pending update.
 */
export function subscribeAncestorScroll({
  host,
  update,
  scheduler = animationFrames,
}: {
  host: Node;
  update: () => void;
  scheduler?: FrameScheduler;
}): () => void {
  let pendingFrame: number | null = null;

  const runUpdate = () => {
    pendingFrame = null;
    update();
  };

  const handleScroll = (event: Event) => {
    if (pendingFrame !== null) {
      return;
    }
    if (!scrollMovesHost(event.target, host)) {
      return;
    }
    pendingFrame = scheduler.request(runUpdate);
  };

  const listenerOptions = { capture: true, passive: true } as const;
  document.addEventListener("scroll", handleScroll, listenerOptions);

  return () => {
    document.removeEventListener("scroll", handleScroll, listenerOptions);
    if (pendingFrame !== null) {
      scheduler.cancel(pendingFrame);
      pendingFrame = null;
    }
  };
}
