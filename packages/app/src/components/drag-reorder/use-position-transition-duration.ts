import { useLayoutEffect, useMemo, useRef } from "react";

/** Sorted keys of the rows that can animate; null-group rows are fixed headers and footers. */
function motionMembership<T>(
  data: readonly T[],
  keyExtractor: (item: T, index: number) => string,
  getDragGroupKey: ((item: T) => string | null) | undefined,
): string {
  const keys = data.flatMap((item, index) => {
    if (getDragGroupKey && getDragGroupKey(item) === null) return [];
    return [keyExtractor(item, index)];
  });
  return JSON.stringify(keys.sort());
}

/**
 * The position transition duration a list should use for this commit, or 0 to skip motion.
 *
 * Motion is skipped on the first layout, while a user drag owns the reorder (and the commit
 * right after it), and whenever the set of animating rows changes. A row entering or leaving
 * (hydration, filtering, Show more) disables motion for every row in that commit, because the
 * survivors would otherwise slide from positions that never painted together.
 *
 * @param duration the list's `positionTransitionDuration`; undefined means the list does not
 *   animate, so the keys are not derived at all.
 * @param dragging whether a user drag is in progress.
 */
export function usePositionTransitionDuration<T>({
  data,
  keyExtractor,
  getDragGroupKey,
  duration,
  dragging,
}: {
  data: readonly T[];
  keyExtractor: (item: T, index: number) => string;
  getDragGroupKey?: (item: T) => string | null;
  duration: number | undefined;
  dragging: boolean;
}): number {
  const enabled = duration !== undefined;
  const membership = useMemo(
    () => (enabled ? motionMembership(data, keyExtractor, getDragGroupKey) : ""),
    [enabled, data, keyExtractor, getDragGroupKey],
  );
  const previous = useRef({ membership: "", dragging: false });
  const stable = previous.current.membership === membership;
  const dragOwnsMotion = dragging || previous.current.dragging;

  // Record what this commit painted, so the next render compares against it.
  useLayoutEffect(() => {
    previous.current = { membership, dragging };
  }, [membership, dragging]);

  if (!enabled || !stable || dragOwnsMotion) return 0;
  return duration;
}
