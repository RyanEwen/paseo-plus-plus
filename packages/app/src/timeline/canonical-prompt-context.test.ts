import { describe, expect, it, vi } from "vitest";
import { createCanonicalPromptContexts } from "./canonical-prompt-context";

describe("createCanonicalPromptContexts", () => {
  it("holds no ordinary-store subscription until it admits a scope", () => {
    // React can discard an owner built during render before commit, so creation must not subscribe.
    const unsubscribe = vi.fn();
    const subscribeOrdinary = vi.fn(() => unsubscribe);
    const owner = createCanonicalPromptContexts(() => true, undefined, subscribeOrdinary);

    expect(subscribeOrdinary).not.toHaveBeenCalled();

    owner.setEpoch("agent", "epoch-1");
    owner.setEpoch("agent", "epoch-2");
    expect(subscribeOrdinary).toHaveBeenCalledTimes(1);

    owner.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("does not subscribe after disposal", () => {
    const subscribeOrdinary = vi.fn(() => () => undefined);
    const owner = createCanonicalPromptContexts(() => true, undefined, subscribeOrdinary);

    owner.dispose();
    owner.setEpoch("agent", "epoch-1");

    expect(subscribeOrdinary).not.toHaveBeenCalled();
  });
});
