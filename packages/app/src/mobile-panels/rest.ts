import { useAnimatedReaction, type SharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { canBeginMobilePanelGesture, type MobilePanelMotionState } from "./model";

// A panel is at rest when it is settled at its anchor with no gesture in progress: exactly
// the state a gesture may begin from. Retained content must not render gesture progress, so
// imperative consumers get only these rest boundaries, not per-frame motion.
const restListeners = new Set<() => void>();

function publishMobilePanelRest(): void {
  for (const listener of restListeners) listener();
}

/** Run listener whenever the settled panel starts or stops resting at its anchor. */
export function subscribeMobilePanelRest(listener: () => void): () => void {
  restListeners.add(listener);
  return () => {
    restListeners.delete(listener);
  };
}

/** Publish rest boundaries from the provider's motion state; mounted once by MobilePanelsProvider. */
export function useMobilePanelRestPublisher(runtime: {
  motionState: SharedValue<MobilePanelMotionState>;
  position: SharedValue<number>;
}): void {
  const { motionState, position } = runtime;
  useAnimatedReaction(
    () => {
      const state = motionState.value;
      return canBeginMobilePanelGesture(state, state.target, position.value);
    },
    (atRest, previous) => {
      if (previous !== null && atRest !== previous) scheduleOnRN(publishMobilePanelRest);
    },
  );
}
