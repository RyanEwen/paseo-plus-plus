import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

/**
 * Synchronous layout-driven state updates allowed per animation frame. Layout effects and
 * ResizeObserver callbacks can chain inside one synchronous React commit, so a small budget
 * keeps any chain far below React's nested update limit (#185).
 */
const LAYOUT_UPDATES_PER_FRAME = 3;

/**
 * A per-frame budget for state updates that follow from measuring layout. `spend` returns
 * true while the frame's budget lasts; once it is spent it returns false and runs `retry`
 * once on the next animation frame, with a fresh budget, instead of updating now.
 */
export function useLayoutUpdateBudget(retry: () => void): () => boolean {
  const retryRef = useRef(retry);
  useLayoutEffect(() => {
    retryRef.current = retry;
  }, [retry]);
  const state = useRef({ spent: 0, frame: null as number | null, pending: false });
  const scheduleFrame = useCallback(() => {
    const budget = state.current;
    if (budget.frame !== null) return;
    budget.frame = requestAnimationFrame(() => {
      budget.frame = null;
      budget.spent = 0;
      if (!budget.pending) return;
      budget.pending = false;
      retryRef.current();
    });
  }, []);
  useEffect(() => {
    const budget = state.current;
    return () => {
      if (budget.frame !== null) cancelAnimationFrame(budget.frame);
      budget.frame = null;
    };
  }, []);
  return useCallback(() => {
    const budget = state.current;
    scheduleFrame();
    if (budget.spent >= LAYOUT_UPDATES_PER_FRAME) {
      budget.pending = true;
      return false;
    }
    budget.spent += 1;
    return true;
  }, [scheduleFrame]);
}
