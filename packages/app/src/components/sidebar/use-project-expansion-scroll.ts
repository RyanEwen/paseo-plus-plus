import { useCallback, useMemo } from "react";
import type { ScrollView, View } from "react-native";
import { useAnimatedRef, useScrollOffset } from "react-native-reanimated";
import { anchorProjectExpansion } from "./project-expansion-anchor";
import { createProjectScrollRef } from "./project-scroll-ref";
import { useExpansionFollowing } from "./use-expansion-following";

interface HeaderGeometry {
  headerTop: number;
  viewportTop: number;
}

/** Measure the header and the scroll viewport in window coordinates; null once it is hidden. */
function measureNativeHeader(
  target: View,
  viewport: Pick<View, "measureInWindow">,
  receive: (geometry: HeaderGeometry | null) => void,
) {
  target.measureInWindow((_x, headerTop, width) => {
    if (width === 0) {
      receive(null);
      return;
    }
    viewport.measureInWindow((_vx, viewportTop) => receive({ headerTop, viewportTop }));
  });
}

/**
 * Native scroll owner for anchored project expansion.
 *
 * Native layout animations expose no painted progress, so each frame measures the header and the
 * scroll viewport with `measureInWindow` and follows a clock over `duration`.
 *
 * @returns `ref` for the scroll container, `anchor` to provide as the expansion anchor, and
 *   `cancel` for user scroll input.
 */
export function useProjectExpansionScroll(duration: number) {
  const animatedRef = useAnimatedRef<ScrollView>();
  const ref = useMemo(() => createProjectScrollRef(animatedRef), [animatedRef]);
  // NestableScrollContainer owns onScroll; subscribe to its native tag without replacing it.
  const offset = useScrollOffset(animatedRef);
  const { cancel, start } = useExpansionFollowing(duration);

  const anchor = useCallback(
    (target: View, toggle: () => void) => {
      cancel();
      const viewport = animatedRef.current;
      const nativeViewport = viewport?.getNativeScrollRef();
      if (!viewport || !nativeViewport) {
        toggle();
        return;
      }
      start(
        anchorProjectExpansion({
          duration,
          toggle,
          measure: (receive) => measureNativeHeader(target, nativeViewport, receive),
          scrollBy: (delta) =>
            viewport.scrollTo({ y: Math.max(0, offset.value + delta), animated: false }),
        }),
      );
    },
    [animatedRef, cancel, duration, offset, start],
  );
  return { ref, anchor, cancel };
}
