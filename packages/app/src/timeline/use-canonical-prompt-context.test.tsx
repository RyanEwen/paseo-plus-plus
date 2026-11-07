// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { StreamItem } from "@/types/stream";
import { createCanonicalPromptContexts } from "./canonical-prompt-context";
import { rawPromptLookup } from "./canonical-prompt-context.test-fixture";
import { canonicalPromptSourceKey } from "./canonical-prompt-model";
import { useCanonicalPromptContext } from "./use-canonical-prompt-context";

// Characterization of the prompt context owner and its hook: admission, suspension,
// cancellation, owner replacement, rejected predecessors and epoch fencing.
type UserPrompt = Extract<StreamItem, { kind: "user_message" }>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("canonical prompt context owner", () => {
  const source: Extract<StreamItem, { kind: "assistant_message" }> = {
    kind: "assistant_message",
    id: "response",
    text: "answer",
    timestamp: new Date(0),
    timelineCursor: { epoch: "epoch", seq: 50 },
  };
  const prompt: UserPrompt = {
    kind: "user_message",
    id: "canonical-user",
    text: "full original",
    timestamp: new Date(0),
    timelineCursor: { epoch: "epoch", seq: 4 },
  };
  const proof = {
    sourceKey: canonicalPromptSourceKey(source),
    sourceStart: 40,
    sourceEnd: 50,
    prompt,
  };

  it("admits the initial assistant-only tail without restarting on streamed text", async () => {
    const owner = createCanonicalPromptContexts();
    const held = deferred<typeof proof>();
    const fetchContext = vi.fn(() => held.promise);
    const { result, rerender, unmount } = renderHook(useCanonicalPromptContext, {
      initialProps: {
        owner,
        agentId: "agent",
        epoch: "epoch",
        source,
        enabled: true,
        lookup: rawPromptLookup(source, fetchContext),
      },
    });
    await waitFor(() => expect(fetchContext).toHaveBeenCalledTimes(1));
    rerender({
      owner,
      agentId: "agent",
      epoch: "epoch",
      source: { ...source, text: "answer extended" },
      enabled: true,
      lookup: rawPromptLookup(source, fetchContext),
    });
    expect(fetchContext).toHaveBeenCalledTimes(1);
    await act(async () => held.resolve(proof));
    expect(result.current.contexts).toMatchObject([proof]);
    expect(result.current.loading).toBe(false);
    unmount();
    owner.dispose();
  });

  it("retains the admitted row through opt-out or hidden-pane suspension and resets scoped cancellation", async () => {
    const owner = createCanonicalPromptContexts();
    const fetchContext = vi.fn().mockResolvedValue(proof);
    const input = {
      owner,
      agentId: "agent",
      epoch: "epoch",
      source,
      enabled: true,
      lookup: rawPromptLookup(source, fetchContext),
    };
    const { result, rerender, unmount } = renderHook(useCanonicalPromptContext, {
      initialProps: input,
    });
    await waitFor(() => expect(result.current.contexts).toMatchObject([proof]));
    const admitted = result.current.contexts;
    act(() => result.current.cancel());
    expect(result.current.cancelled).toBe(true);
    rerender({ ...input, enabled: false });
    expect(result.current.contexts).toBe(admitted);
    expect(result.current.cancelled).toBe(false);
    rerender(input);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.contexts).toBe(admitted);
    expect(result.current.cancelled).toBe(false);
    expect(fetchContext).toHaveBeenCalledTimes(1);
    unmount();
    owner.dispose();
  });

  it("rejects a held admission after pane suspension without cancelling the next pane scope", async () => {
    const owner = createCanonicalPromptContexts();
    const held = deferred<typeof proof>();
    const fetchContext = vi
      .fn()
      .mockImplementationOnce(() => held.promise)
      .mockResolvedValueOnce(proof);
    const input = {
      owner,
      agentId: "agent",
      epoch: "epoch",
      source,
      enabled: true,
      lookup: rawPromptLookup(source, fetchContext),
    };
    const { result, rerender, unmount } = renderHook(useCanonicalPromptContext, {
      initialProps: input,
    });
    await waitFor(() => expect(fetchContext).toHaveBeenCalledTimes(1));
    rerender({ ...input, enabled: false });
    await act(async () => held.resolve(proof));
    expect(owner.read("agent", "epoch")).toEqual([]);
    expect(result.current.loading).toBe(false);
    rerender(input);
    await waitFor(() => expect(result.current.contexts).toMatchObject([proof]));
    expect(fetchContext).toHaveBeenCalledTimes(2);
    unmount();
    owner.dispose();
  });

  it("isolates a replacement owner from cancelled and held completions in the same epoch", async () => {
    const owner = createCanonicalPromptContexts();
    const replacement = createCanonicalPromptContexts();
    const held = deferred<typeof proof>();
    const fetchContext = vi
      .fn()
      .mockImplementationOnce(() => held.promise)
      .mockResolvedValueOnce(proof);
    const input = {
      owner,
      agentId: "agent",
      epoch: "epoch",
      source,
      enabled: true,
      lookup: rawPromptLookup(source, fetchContext),
    };
    const { result, rerender, unmount } = renderHook(useCanonicalPromptContext, {
      initialProps: input,
    });
    await waitFor(() => expect(fetchContext).toHaveBeenCalledTimes(1));
    act(() => result.current.cancel());
    rerender({ ...input, owner: replacement });
    await waitFor(() => expect(result.current.contexts).toMatchObject([proof]));
    await act(async () => held.resolve(proof));
    expect(owner.read("agent", "epoch")).toEqual([]);
    expect(result.current.cancelled).toBe(false);
    expect(result.current.contexts[0]?.prompt).toMatchObject(prompt);
    expect(fetchContext).toHaveBeenCalledTimes(2);
    unmount();
    owner.dispose();
    replacement.dispose();
  });

  it("rejects an unproved predecessor and exposes retry instead of a successful content-only fallback", async () => {
    const owner = createCanonicalPromptContexts();
    const fetchContext = vi
      .fn()
      .mockResolvedValueOnce({
        ...proof,
        prompt: { ...prompt, timelineCursor: { epoch: "epoch", seq: 45 } },
      })
      .mockResolvedValueOnce(proof);
    const { result, unmount } = renderHook(() =>
      useCanonicalPromptContext({
        owner,
        agentId: "agent",
        epoch: "epoch",
        source,
        enabled: true,
        lookup: rawPromptLookup(source, fetchContext),
      }),
    );
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.contexts).toEqual([]);
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.contexts).toMatchObject([proof]));
    expect(result.current.error).toBe(false);
    expect(fetchContext).toHaveBeenCalledTimes(2);
    unmount();
    owner.dispose();
  });

  it("fences cancellation and epoch replacement even when a held reader ignores its signal", async () => {
    const owner = createCanonicalPromptContexts();
    const held = deferred<typeof proof>();
    const fetchContext = vi.fn(() => held.promise);
    const { result, rerender, unmount } = renderHook(useCanonicalPromptContext, {
      initialProps: {
        owner,
        agentId: "agent",
        epoch: "epoch",
        source,
        enabled: true,
        lookup: rawPromptLookup(source, fetchContext),
      },
    });
    await waitFor(() => expect(fetchContext).toHaveBeenCalledTimes(1));
    act(() => result.current.cancel());
    await act(async () => held.resolve(proof));
    expect(result.current.contexts).toEqual([]);
    expect(result.current.cancelled).toBe(true);
    const changed = { ...source, timelineCursor: { epoch: "new", seq: 50 } };
    const next = {
      ...proof,
      sourceKey: canonicalPromptSourceKey(changed),
      prompt: { ...prompt, timelineCursor: { epoch: "new", seq: 4 } },
    };
    const readNext = vi.fn().mockResolvedValue(next);
    rerender({
      owner,
      agentId: "agent",
      epoch: "new",
      source: changed,
      enabled: true,
      lookup: rawPromptLookup(changed, readNext),
    });
    await waitFor(() => expect(result.current.contexts).toMatchObject([next]));
    expect(result.current.cancelled).toBe(false);
    expect(owner.read("agent", "epoch")).toEqual([]);
    unmount();
    owner.dispose();
  });
});
