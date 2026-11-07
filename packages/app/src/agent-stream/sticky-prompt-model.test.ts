import { describe, expect, it } from "vitest";
import {
  INITIAL_STICKY_PROMPT_STATE,
  reduceStickyPromptState,
  type StickyPromptState,
  hasDiscoveredCachedPrompt,
  hasDiscoveredPrompt,
  isNextPromptDisabled,
  resolveContextMessage,
  resolvePromptFeedback,
  resolveStickyPromptMessage,
  shouldDiscoverCachedPrompt,
  shouldDiscoverPrompt,
  shouldReadContext,
  type PromptTarget,
  type UserPrompt,
} from "./sticky-prompt-model";

function prompt(id: string, seq: number): UserPrompt {
  return {
    kind: "user_message",
    id,
    text: id,
    timestamp: new Date(0),
    timelineCursor: { epoch: "e", seq },
  };
}

const IDLE_NAVIGATION = {
  busy: false,
  error: false,
  cancelled: false,
  discoveryStatus: "idle" as const,
};

const CONTEXT_FEEDBACK = {
  loading: false,
  error: false,
  cancelled: false,
  limited: false,
  exhausted: false,
};

describe("resolvePromptFeedback", () => {
  it("keeps an available prompt free of retained-context feedback", () => {
    const message = prompt("u1", 1);
    const feedback = resolvePromptFeedback(
      { ...IDLE_NAVIGATION, message },
      { ...CONTEXT_FEEDBACK, loading: true, error: true },
    );

    expect(feedback).toEqual({ ...IDLE_NAVIGATION, message, retryContext: false });
  });

  it("shows a context failure in the placeholder and lets Retry restart the context owner", () => {
    const feedback = resolvePromptFeedback(
      { ...IDLE_NAVIGATION, message: undefined },
      { ...CONTEXT_FEEDBACK, error: true },
    );

    expect(feedback).toMatchObject({ error: true, retryContext: true });
  });

  it("reports a limited context as limited discovery when navigation itself is fine", () => {
    const feedback = resolvePromptFeedback(
      { ...IDLE_NAVIGATION, message: undefined },
      { ...CONTEXT_FEEDBACK, limited: true },
    );

    expect(feedback).toMatchObject({ discoveryStatus: "limited", retryContext: true });
  });

  it("keeps the navigation failure's own Retry ahead of a context failure", () => {
    const feedback = resolvePromptFeedback(
      { ...IDLE_NAVIGATION, error: true, message: undefined },
      { ...CONTEXT_FEEDBACK, error: true },
    );

    expect(feedback).toMatchObject({ error: true, retryContext: false });
  });
});

describe("prompt discovery predicates", () => {
  const discovery = {
    previous: false,
    indexed: false,
    message: undefined,
    cancelled: false,
    readingMissing: false,
  };

  it("discovers an earlier prompt without an index until one is shown", () => {
    expect(shouldDiscoverPrompt(discovery)).toBe(true);
    expect(shouldDiscoverPrompt({ ...discovery, message: prompt("u1", 1) })).toBe(false);
    expect(shouldDiscoverPrompt({ ...discovery, indexed: true })).toBe(false);
    expect(shouldDiscoverPrompt({ ...discovery, cancelled: true })).toBe(false);
  });

  it("always discovers when moving to the previous prompt", () => {
    expect(shouldDiscoverPrompt({ ...discovery, previous: true, indexed: true })).toBe(true);
  });

  it("finishes discovery on the target of its mode", () => {
    const target: PromptTarget = { key: "e:1", seq: 1 };
    const base = {
      previousMode: false,
      previous: undefined,
      readingMode: false,
      target: undefined,
      message: undefined,
    };

    expect(hasDiscoveredPrompt({ ...base, previousMode: true, previous: target })).toBe(true);
    expect(hasDiscoveredPrompt({ ...base, previousMode: true, message: prompt("u1", 1) })).toBe(
      false,
    );
    expect(hasDiscoveredPrompt({ ...base, readingMode: true, target })).toBe(true);
    expect(hasDiscoveredPrompt({ ...base, message: prompt("u1", 1) })).toBe(true);
  });

  it("explicitly revealed cached rows page history only without an index", () => {
    const pending: PromptTarget = { key: "e:3", seq: 3, cached: true };
    const input = { pending, indexed: false, message: undefined, cancelled: false };

    expect(shouldDiscoverCachedPrompt({ ...input, readingMissing: false })).toBe(true);
    expect(shouldDiscoverCachedPrompt({ ...input, indexed: true, readingMissing: false })).toBe(
      false,
    );
  });

  it("passive reading context never starts discovery", () => {
    expect(
      shouldDiscoverCachedPrompt({
        pending: null,
        indexed: false,
        message: undefined,
        cancelled: false,
        readingMissing: true,
      }),
    ).toBe(false);
  });

  it("stops paging for a cached row only when its original row is loaded", () => {
    const pending: PromptTarget = { key: "e:3", seq: 3, cached: true };
    const input = {
      pending,
      previous: undefined,
      readingMissing: false,
      readingTarget: undefined,
      message: undefined,
    };

    expect(
      hasDiscoveredCachedPrompt({ ...input, loaded: [{ ...pending, item: prompt("u3", 3) }] }),
    ).toBe(false);
    expect(
      hasDiscoveredCachedPrompt({
        ...input,
        loaded: [{ key: "e:3", seq: 3, item: prompt("u3", 3) }],
      }),
    ).toBe(true);
  });
});

describe("prompt message resolution", () => {
  const selected = prompt("selected", 1);
  const fetched = prompt("fetched", 2);

  it("shows no unrelated prompt while the reading prompt is missing", () => {
    expect(
      resolveStickyPromptMessage({
        selected,
        fetched,
        readingMissing: true,
        missingSeq: 2,
        canFetch: true,
      }),
    ).toBeUndefined();
  });

  it("uses a fetched prompt only when it can be fetched for a missing sequence", () => {
    const input = { selected, fetched, readingMissing: false, missingSeq: 2 };

    expect(resolveStickyPromptMessage({ ...input, canFetch: true })).toBe(fetched);
    expect(resolveStickyPromptMessage({ ...input, canFetch: false })).toBe(selected);
  });

  it("freezes an explicit selection while its original loads", () => {
    const input = { selected, fetched, missingSeq: undefined, canFetch: true };

    expect(
      resolveContextMessage({ ...input, pending: { key: "e:1", seq: 1 }, missing: true }),
    ).toBe(selected);
    expect(resolveContextMessage({ ...input, pending: null, missing: true })).toBe(fetched);
    expect(resolveContextMessage({ ...input, pending: null, missing: false })).toBe(selected);
  });

  it("reads passive context only for manual reading without pending navigation", () => {
    const input = { enabled: true, missing: true, cancelled: false, navigating: false };

    expect(shouldReadContext({ ...input, pending: null })).toBe(true);
    expect(shouldReadContext({ ...input, pending: "previous" })).toBe(false);
    expect(shouldReadContext({ ...input, navigating: true, pending: null })).toBe(false);
    expect(shouldReadContext({ ...input, enabled: false, pending: null })).toBe(false);
  });

  it("disables next at the newest known prompt", () => {
    const message = prompt("u1", 1);

    expect(isNextPromptDisabled(message, 0, 2)).toBe(false);
    expect(isNextPromptDisabled(message, 1, 2)).toBe(true);
    expect(isNextPromptDisabled(undefined, 0, 2)).toBe(true);
  });
});

describe("reduceStickyPromptState", () => {
  const held = prompt("held", 2);
  const target: PromptTarget = { key: "e:1", seq: 1 };
  const failed: StickyPromptState = {
    selected: held,
    pending: target,
    error: true,
    cancelled: false,
  };

  it("returns the same state when an event changes nothing", () => {
    expect(reduceStickyPromptState(failed, { type: "readingSelected", selected: held })).toBe(
      failed,
    );
    expect(reduceStickyPromptState(INITIAL_STICKY_PROMPT_STATE, { type: "previousNotFound" })).toBe(
      INITIAL_STICKY_PROMPT_STATE,
    );
  });

  it("holds a navigated prompt and clears an earlier cancellation", () => {
    expect(
      reduceStickyPromptState(
        { ...INITIAL_STICKY_PROMPT_STATE, cancelled: true },
        { type: "navigationStarted", selected: held },
      ),
    ).toEqual({ ...INITIAL_STICKY_PROMPT_STATE, selected: held });
  });

  it("clears a failure when a selection starts and settles a shown target", () => {
    const started = reduceStickyPromptState(failed, { type: "selectionStarted" });
    expect(started.error).toBe(false);
    expect(reduceStickyPromptState(started, { type: "targetShown", selected: null })).toEqual({
      selected: null,
      pending: null,
      error: false,
      cancelled: false,
    });
  });

  it("waits for a requested target and fails it without keeping it pending", () => {
    const requested = reduceStickyPromptState(INITIAL_STICKY_PROMPT_STATE, {
      type: "targetRequested",
      target,
    });
    expect(requested.pending).toBe(target);
    expect(reduceStickyPromptState(requested, { type: "pendingFailed" })).toMatchObject({
      pending: null,
      error: true,
    });
    expect(reduceStickyPromptState(requested, { type: "targetUnreachable" })).toMatchObject({
      pending: null,
      error: true,
    });
  });

  it("shows the loaded original of a pending target", () => {
    expect(
      reduceStickyPromptState(
        { ...INITIAL_STICKY_PROMPT_STATE, pending: target },
        { type: "pendingLoaded", selected: held },
      ),
    ).toEqual({ ...INITIAL_STICKY_PROMPT_STATE, selected: held });
  });

  it("searches for and abandons a previous prompt", () => {
    const searching = reduceStickyPromptState(INITIAL_STICKY_PROMPT_STATE, {
      type: "previousRequested",
    });
    expect(searching.pending).toBe("previous");
    expect(reduceStickyPromptState(searching, { type: "previousNotFound" }).pending).toBeNull();
  });

  it("cancels and resumes reading without dropping the held prompt", () => {
    const cancelled = reduceStickyPromptState(failed, { type: "cancelled" });
    expect(cancelled).toEqual({ selected: held, pending: null, error: false, cancelled: true });
    expect(reduceStickyPromptState(cancelled, { type: "readingReviewed" })).toEqual({
      selected: held,
      pending: null,
      error: false,
      cancelled: false,
    });
    expect(reduceStickyPromptState(cancelled, { type: "retried" }).cancelled).toBe(false);
    expect(reduceStickyPromptState(cancelled, { type: "enabled" }).cancelled).toBe(false);
  });

  it("follows the latest prompt by releasing the held one", () => {
    expect(reduceStickyPromptState(failed, { type: "latestFollowed" }).selected).toBeNull();
    expect(
      reduceStickyPromptState(failed, { type: "readingSelected", selected: held }).selected,
    ).toBe(held);
    expect(
      reduceStickyPromptState(failed, { type: "revealStarted", selected: null }).selected,
    ).toBe(null);
  });

  it("resets prompt ownership on opt-out and epoch replacement", () => {
    expect(reduceStickyPromptState(failed, { type: "disabled" })).toEqual({
      ...INITIAL_STICKY_PROMPT_STATE,
      cancelled: true,
    });
    expect(reduceStickyPromptState(failed, { type: "epochReplaced", enabled: true })).toEqual(
      INITIAL_STICKY_PROMPT_STATE,
    );
    expect(
      reduceStickyPromptState(failed, { type: "epochReplaced", enabled: false }).cancelled,
    ).toBe(true);
  });
});
