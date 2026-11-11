import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

/**
 * Layout-driven state updates allowed in one synchronous chain. Layout effects and the
 * updates they set re-render inside the same React commit, so a small budget keeps any such
 * chain far below React's nested update limit (#185).
 */
const LAYOUT_UPDATES_PER_CHAIN = 3;

interface BudgetState {
  spent: number;
  /** Whether a microtask is queued to refill the budget once the current chain ends. */
  refillQueued: boolean;
  frame: number | null;
  /** Whether a refused update is waiting for the next animation frame. */
  pending: boolean;
}

/**
 * A budget for state updates that follow from measuring layout. `spend` returns true while
 * the budget lasts. Once it is spent, `spend` returns false and runs `retry` once on the next
 * animation frame instead of updating now.
 *
 * The budget refills when the current synchronous chain ends, so separate events, such as
 * several scrolls in one slow frame, each get the full budget. Only a chain that keeps
 * re-rendering itself inside one commit, the shape of #185, is cut off and moved to a frame.
 */
export function useLayoutUpdateBudget(retry: () => void): () => boolean {
  const retryRef = useRef(retry);
  useLayoutEffect(() => {
    retryRef.current = retry;
  }, [retry]);
  const state = useRef<BudgetState>({ spent: 0, refillQueued: false, frame: null, pending: false });

  // Runs a refused update on the next frame, with a fresh budget.
  const scheduleRetry = useCallback(() => {
    const budget = state.current;
    budget.pending = true;
    if (budget.frame !== null) return;
    budget.frame = requestAnimationFrame(() => {
      budget.frame = null;
      budget.spent = 0;
      if (!budget.pending) return;
      budget.pending = false;
      retryRef.current();
    });
  }, []);

  // A synchronous chain cannot span a microtask, so refill once the current one finishes.
  const queueRefill = useCallback(() => {
    const budget = state.current;
    if (budget.refillQueued) return;
    budget.refillQueued = true;
    queueMicrotask(() => {
      budget.refillQueued = false;
      budget.spent = 0;
    });
  }, []);

  useEffect(() => {
    const budget = state.current;
    return () => {
      if (budget.frame !== null) cancelAnimationFrame(budget.frame);
      budget.frame = null;
      budget.pending = false;
    };
  }, []);

  return useCallback(() => {
    const budget = state.current;
    if (budget.spent >= LAYOUT_UPDATES_PER_CHAIN) {
      scheduleRetry();
      return false;
    }
    budget.spent += 1;
    queueRefill();
    return true;
  }, [queueRefill, scheduleRetry]);
}
