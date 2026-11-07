// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { StreamItem } from "@/types/stream";
import type { UserPrompt } from "./sticky-prompt-model";
import { useReadingPrompt, type ReadingPromptRequest } from "./use-reading-prompt";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function prompt(id: string, seq: number, epoch = "epoch-1"): UserPrompt {
  return {
    kind: "user_message",
    id,
    text: id,
    timestamp: new Date(0),
    timelineCursor: { epoch, seq },
  };
}

function promptRequest(fetchPrompt: (seq: number) => Promise<UserPrompt>): ReadingPromptRequest {
  return { kind: "prompt", seq: 1, fetchPrompt };
}

describe("useReadingPrompt", () => {
  it("fences a held old-epoch read while fetching the same sequence in the new epoch", async () => {
    const old = deferred<UserPrompt>();
    const fresh = deferred<UserPrompt>();
    const fetchPrompt = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const input = { epoch: "epoch-1", knownPrompts: [], request: promptRequest(fetchPrompt) };
    const { result, rerender } = renderHook(useReadingPrompt, { initialProps: input });

    rerender({ ...input, epoch: "epoch-2" });
    expect(fetchPrompt).toHaveBeenCalledTimes(2);
    await act(async () => old.resolve(prompt("same", 1)));
    expect(result.current.item).toBeUndefined();
    expect(result.current.loading).toBe(true);

    const replacement = { ...prompt("same", 1, "epoch-2"), text: "Fresh content" };
    await act(async () => fresh.resolve(replacement));
    expect(result.current.item).toEqual(replacement);
    expect(result.current.error).toBe(false);
  });

  it("does not reuse resolved content when an epoch reuses the same prompt identity", async () => {
    const old = prompt("same", 1);
    const replacement = { ...prompt("same", 1, "epoch-2"), text: "Fresh content" };
    const fetchPrompt = vi.fn().mockResolvedValueOnce(old).mockResolvedValueOnce(replacement);
    const input = { epoch: "epoch-1", knownPrompts: [], request: promptRequest(fetchPrompt) };
    const { result, rerender } = renderHook(useReadingPrompt, { initialProps: input });

    await waitFor(() => expect(result.current.item).toEqual(old));
    rerender({ ...input, epoch: "epoch-2" });
    await waitFor(() => expect(result.current.item).toEqual(replacement));
    expect(fetchPrompt).toHaveBeenCalledTimes(2);
  });

  it("serves a known prompt from the cache without reading", async () => {
    const known = prompt("known", 1);
    const fetchPrompt = vi.fn();
    const { result } = renderHook(useReadingPrompt, {
      initialProps: {
        epoch: "epoch-1",
        knownPrompts: [known],
        request: promptRequest(fetchPrompt),
      },
    });

    await waitFor(() => expect(result.current.item).toBe(known));
    expect(fetchPrompt).not.toHaveBeenCalled();
  });

  it("does not read a request whose reader is absent", () => {
    const source: StreamItem = {
      kind: "assistant_message",
      id: "answer",
      text: "Answer",
      timestamp: new Date(0),
      timelineCursor: { epoch: "epoch-1", seq: 2 },
    };
    const { result } = renderHook(useReadingPrompt, {
      initialProps: {
        epoch: "epoch-1",
        knownPrompts: [],
        request: { kind: "context", source, fetchContext: undefined } as ReadingPromptRequest,
      },
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.item).toBeUndefined();
  });

  it("reports a failed read and recovers on retry", async () => {
    const recovered = prompt("recovered", 1);
    const fetchPrompt = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(recovered);
    const { result } = renderHook(useReadingPrompt, {
      initialProps: { epoch: "epoch-1", knownPrompts: [], request: promptRequest(fetchPrompt) },
    });

    await waitFor(() => expect(result.current.error).toBe(true));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.item).toEqual(recovered));
    expect(result.current.error).toBe(false);
  });
});
