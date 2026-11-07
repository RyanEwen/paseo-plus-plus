import { createContext, useCallback, useContext, useRef } from "react";
import type { View } from "react-native";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";

/** Expand a project while keeping `target` (its header) in view; the provider decides how. */
export type AnchorProjectExpansion = (target: View, toggle: () => void) => void;

/**
 * Supplied by the project-mode list's scroll owner. Outside it (status mode, tests) the default
 * toggles immediately without anchoring.
 */
export const ProjectExpansionAnchorContext = createContext<AnchorProjectExpansion>(
  (_target, toggle) => toggle(),
);

/**
 * A project header's toggle that anchors the expansion when Expand one project at a time is on.
 *
 * @param collapsed whether the project is collapsed now; only expanding is anchored, because
 *   that is when the groups above collapse and would scroll the header away.
 * @returns `ref` for the project's container view and `onToggle` for its header.
 */
export function useAnchoredProjectToggle({
  collapsed,
  toggle,
}: {
  collapsed: boolean;
  toggle: () => void;
}) {
  const ref = useRef<View>(null);
  const anchor = useContext(ProjectExpansionAnchorContext);
  const oneProjectAtATime = useSidebarViewStore((state) => state.oneProjectAtATime);
  const onToggle = useCallback(() => {
    const target = ref.current;
    if (collapsed && oneProjectAtATime && target) {
      anchor(target, toggle);
    } else {
      toggle();
    }
  }, [anchor, collapsed, oneProjectAtATime, toggle]);
  return { ref, onToggle };
}

export interface ProjectExpansionFollowing {
  cancel: () => void;
  dispose: () => void;
}

interface ExpansionGeometry {
  headerTop: number;
  viewportTop: number;
  /** Actual painted transition progress when the platform exposes it. */
  transitionProgress?: number;
}

/** Linear progress through `duration` when the platform does not report painted progress. */
function clockProgress(time: number, start: number, duration: number): number {
  return duration > 0 ? Math.min(1, (time - start) / duration) : 1;
}

/** Scroll so the header sits on its path from where it started to the top of the viewport. */
function scrollTowardTarget({
  geometry,
  initialTop,
  progress,
  scrollBy,
}: {
  geometry: ExpansionGeometry;
  initialTop: number;
  progress: number;
  scrollBy: (delta: number) => void;
}) {
  // Arrive at this project, rather than retaining an offset that can clamp to list start.
  const targetTop = initialTop * (1 - progress);
  const delta = geometry.headerTop - geometry.viewportTop - targetTop;
  if (Math.abs(delta) > 0.5) scrollBy(delta);
}

/** Follow painted coordinates: the list owns easing and may be interrupted mid-transition. */
export function anchorProjectExpansion({
  measure,
  scrollBy,
  duration,
  toggle,
  // Resolve the browser globals only when a frame is requested, so tests without a DOM can
  // exercise cancellation paths that never schedule one.
  requestFrame = (callback) => requestAnimationFrame(callback),
  cancelFrame = (handle) => cancelAnimationFrame(handle),
}: {
  measure: (receive: (geometry: ExpansionGeometry | null) => void) => void;
  scrollBy: (delta: number) => void;
  duration: number;
  toggle: () => void;
  requestFrame?: typeof requestAnimationFrame;
  cancelFrame?: typeof cancelAnimationFrame;
}): ProjectExpansionFollowing {
  let cancelled = false;
  let disposed = false;
  let toggled = false;
  let frame: number | undefined;
  let start: number | undefined;
  let initialTop = 0;

  const commitToggle = () => {
    if (disposed || toggled) return;
    toggled = true;
    toggle();
  };

  const applyFrame = (geometry: ExpansionGeometry | null, time: number, startedAt: number) => {
    if (cancelled || !geometry) return;
    const progress = geometry.transitionProgress ?? clockProgress(time, startedAt, duration);
    scrollTowardTarget({ geometry, initialTop, progress, scrollBy });
    if (progress < 1) frame = requestFrame(followFrame);
  };

  function followFrame(time: number) {
    if (cancelled) return;
    const startedAt = (start ??= time);
    measure((geometry) => applyFrame(geometry, time, startedAt));
  }

  // The first measurement fixes where the header started, then the toggle runs.
  measure((initial) => {
    if (disposed) return;
    commitToggle();
    if (cancelled || !initial) return;
    initialTop = Math.max(0, initial.headerTop - initial.viewportTop);
    frame = requestFrame(followFrame);
  });

  const stopFrames = () => {
    cancelled = true;
    if (frame !== undefined) cancelFrame(frame);
  };
  return {
    cancel: () => {
      stopFrames();
      // Scrolling can be cancelled; the user's accepted expansion must still happen once.
      // Flush it before a newer click so delayed native measurements cannot reorder toggles.
      commitToggle();
    },
    dispose: () => {
      disposed = true;
      stopFrames();
    },
  };
}
