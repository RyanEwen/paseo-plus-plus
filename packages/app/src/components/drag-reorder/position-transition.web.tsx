import { useLayoutEffect, useRef, type ReactNode } from "react";

/** Read layout coordinates without scroll or transforms, including animated ancestors. */
function layoutTop(node: HTMLElement): number {
  let top = 0;
  let current: HTMLElement | null = node;
  while (current) {
    top += current.offsetTop;
    const parent: Element | null = current.offsetParent;
    current = parent instanceof HTMLElement ? parent : null;
  }
  return top;
}

/**
 * The starting translateY for a cell's position transition, or null when it should not move.
 *
 * @param previous the cell's last painted layout top, relative to its animated ancestor.
 * @param top the cell's new layout top in the same coordinates.
 * @param interruptedOffset the translateY a still-running transition paints right now; a newer
 *   move starts from that painted position rather than from the older target.
 */
export function transitionOffset({
  previous,
  top,
  interruptedOffset,
}: {
  previous: number;
  top: number;
  interruptedOffset: number;
}): number | null {
  // A changed grouping can leave the layout target unchanged while the old
  // transition still paints an offset. Settle that offset instead of retaining it.
  if (previous === top && interruptedOffset === 0) return null;
  return previous - top + interruptedOffset;
}

const POSITION_BOUNDARY_STYLE = { position: "relative" as const };

/** Move the existing DOM subtree from its last painted position to its new layout position. */
export function PositionTransition({
  children,
  duration,
  revision,
}: {
  children: ReactNode;
  duration: number;
  revision: unknown;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const previousTop = useRef<number | null>(null);
  const animation = useRef<Animation | null>(null);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const boundary = node.parentElement?.closest("[data-position-transition]");
    const boundaryTop = boundary instanceof HTMLElement ? layoutTop(boundary) : 0;
    const top = layoutTop(node) - boundaryTop;
    const visible =
      node.getClientRects().length > 0 &&
      node.offsetWidth > 0 &&
      !node.closest('[aria-hidden="true"]');
    const previous = previousTop.current;
    previousTop.current = visible ? top : null;

    if (duration === 0 || !visible) {
      animation.current?.cancel();
      animation.current = null;
      return;
    }
    if (previous === null) return;

    const transform = getComputedStyle(node).transform;
    const interruptedOffset = transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m42;
    const offset = transitionOffset({ previous, top, interruptedOffset });
    if (offset === null) return;
    animation.current?.cancel();
    animation.current = node.animate(
      [{ transform: `translateY(${offset}px)` }, { transform: "translateY(0px)" }],
      { duration, easing: "ease-in-out" },
    );
  }, [duration, revision]);

  useLayoutEffect(() => () => animation.current?.cancel(), []);
  return (
    <div ref={ref} data-position-transition="" style={POSITION_BOUNDARY_STYLE}>
      {children}
    </div>
  );
}
