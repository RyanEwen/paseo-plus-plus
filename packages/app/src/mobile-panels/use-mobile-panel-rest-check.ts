import { useCallback } from "react";
import type { MobilePanelView } from "@/stores/panel-store";
import { canBeginMobilePanelGesture } from "./model";
import { useMobilePanelsRuntime } from "./provider";
import { subscribeMobilePanelRest } from "./rest";

/**
 * Read whether a panel is at rest when a side effect runs, without re-rendering on motion.
 *
 * `isAtRest` reads the current motion values; `subscribe` fires when the settled panel starts or
 * stops resting, so the caller can re-check.
 */
export function useMobilePanelRestCheck(panel: MobilePanelView) {
  const { motionState, position } = useMobilePanelsRuntime();
  const isAtRest = useCallback(
    () => canBeginMobilePanelGesture(motionState.value, panel, position.value),
    [motionState, panel, position],
  );
  return { isAtRest, subscribe: subscribeMobilePanelRest };
}
