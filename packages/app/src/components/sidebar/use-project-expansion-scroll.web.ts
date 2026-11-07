import { useCallback, useEffect, useRef } from "react";
import type { ScrollView, View } from "react-native";
import { anchorProjectExpansion } from "./project-expansion-anchor";
import { useExpansionFollowing } from "./use-expansion-following";

/** The header's running Web Animation progress, 1 once it finished, or undefined without one. */
function paintedProgress(transition: Animation | undefined): number | undefined {
  if (!transition) return undefined;
  if (transition.playState === "finished" || transition.playState === "idle") return 1;
  const timing = transition.effect?.getComputedTiming();
  return Math.max(0, Math.min(1, timing?.progress ?? 0));
}

/**
 * Web scroll owner for anchored project expansion.
 *
 * Instead of a parallel clock, each frame reads the progress of the header's own position
 * transition (a Web Animation that can start after React's commit and the first frame), so the
 * scroll stays in step with what is painted.
 *
 * @returns `ref` for the scroll container, `anchor` to provide as the expansion anchor, and
 *   `cancel`, which wheel, touch, pointer and key input on the viewport also call.
 */
export function useProjectExpansionScroll(duration: number) {
  const ref = useRef<ScrollView>(null);
  const { cancel, start } = useExpansionFollowing(duration);

  const anchor = useCallback(
    (target: View, toggle: () => void) => {
      cancel();
      const viewport: unknown = ref.current?.getScrollableNode();
      // RN web's host ref is a DOM node. Narrow it rather than casting a native View ref.
      const header: unknown = target;
      if (!(viewport instanceof HTMLElement) || !(header instanceof HTMLElement)) {
        toggle();
        return;
      }
      const boundary = header.closest<HTMLElement>("[data-position-transition]");
      let transition: Animation | undefined;
      const measureHeader = (
        receive: (
          geometry: { headerTop: number; viewportTop: number; transitionProgress?: number } | null,
        ) => void,
      ) => {
        if (!header.isConnected || header.getClientRects().length === 0) {
          receive(null);
          return;
        }
        transition ??= boundary
          ?.getAnimations()
          .find((animation) => animation.pending || animation.playState === "running");
        receive({
          headerTop: header.getBoundingClientRect().top,
          viewportTop: viewport.getBoundingClientRect().top + viewport.clientTop,
          transitionProgress: paintedProgress(transition),
        });
      };
      start(
        anchorProjectExpansion({
          duration,
          toggle,
          measure: measureHeader,
          scrollBy: (delta) => {
            viewport.scrollTop += delta;
          },
        }),
      );
    },
    [cancel, duration, start],
  );

  useEffect(() => {
    const viewport: unknown = ref.current?.getScrollableNode();
    if (!(viewport instanceof HTMLElement)) return;
    const events = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
    for (const event of events) viewport.addEventListener(event, cancel, { passive: true });
    return () => {
      for (const event of events) viewport.removeEventListener(event, cancel);
    };
  }, [cancel]);

  return { ref, anchor, cancel };
}
