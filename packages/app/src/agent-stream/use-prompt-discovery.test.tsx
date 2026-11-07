// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PROMPT_DISCOVERY_PAGE_BUDGET } from "@/timeline/timeline-fetch-policy";
import {
  isDiscoverySettled,
  usePromptDiscovery,
  type PromptDiscoveryStatus,
} from "./use-prompt-discovery";

function heldPages() {
  const releases: ((started: boolean) => void)[] = [];
  const loadOlder = vi.fn(
    (_acceptance?: { signal: AbortSignal }) =>
      new Promise<boolean>((resolve) => {
        releases.push(resolve);
      }),
  );
  return { loadOlder, release: (index: number) => releases[index]!(true) };
}

function discoveryInput(overrides: Partial<Parameters<typeof usePromptDiscovery>[0]> = {}) {
  return {
    enabled: true,
    reached: false,
    hasOlder: true,
    loadingOlder: false,
    progressKey: "page-0",
    loadOlder: vi.fn(async () => true),
    ...overrides,
  };
}

describe("usePromptDiscovery", () => {
  it("completes without loading when the target is already reached", () => {
    const input = discoveryInput({ reached: true });
    const { result } = renderHook(usePromptDiscovery, { initialProps: input });

    expect(result.current.status).toBe("complete");
    expect(input.loadOlder).not.toHaveBeenCalled();
  });

  it("loads one page per authoritative cursor advance until the target appears", async () => {
    const pages = heldPages();
    const input = discoveryInput({ loadOlder: pages.loadOlder });
    const { result, rerender } = renderHook(usePromptDiscovery, { initialProps: input });
    await waitFor(() => expect(pages.loadOlder).toHaveBeenCalledTimes(1));

    rerender({ ...input, progressKey: "page-1" });
    await act(async () => pages.release(0));
    await waitFor(() => expect(pages.loadOlder).toHaveBeenCalledTimes(2));
    rerender({ ...input, progressKey: "page-2", reached: true });

    await waitFor(() => expect(result.current.status).toBe("complete"));
  });

  it("fails instead of looping when a page does not advance the cursor", async () => {
    const input = discoveryInput();
    const { result } = renderHook(usePromptDiscovery, { initialProps: input });

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(input.loadOlder).toHaveBeenCalledTimes(1);
  });

  it("reports exhausted history after loading", async () => {
    const pages = heldPages();
    const input = discoveryInput({ loadOlder: pages.loadOlder });
    const { result, rerender } = renderHook(usePromptDiscovery, { initialProps: input });
    await waitFor(() => expect(pages.loadOlder).toHaveBeenCalledTimes(1));

    rerender({ ...input, hasOlder: false });
    await act(async () => pages.release(0));

    await waitFor(() => expect(result.current.status).toBe("exhausted"));
  });

  it("stops at its page budget and continues after an explicit restart", async () => {
    const pages = heldPages();
    const input = discoveryInput({ loadOlder: pages.loadOlder });
    const { result, rerender } = renderHook(usePromptDiscovery, { initialProps: input });
    for (let index = 0; index < PROMPT_DISCOVERY_PAGE_BUDGET; index += 1) {
      await waitFor(() => expect(pages.loadOlder).toHaveBeenCalledTimes(index + 1));
      rerender({ ...input, progressKey: `page-${index + 1}` });
      await act(async () => pages.release(index));
    }
    await waitFor(() => expect(result.current.status).toBe("limited"));

    act(() => result.current.restart());

    await waitFor(() =>
      expect(pages.loadOlder).toHaveBeenCalledTimes(PROMPT_DISCOVERY_PAGE_BUDGET + 1),
    );
  });

  it("cancels its page acceptance and ignores the late completion", async () => {
    let release!: (started: boolean) => void;
    const loadOlder = vi.fn(
      (_acceptance?: { signal: AbortSignal }) =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const input = discoveryInput({ loadOlder });
    const { result } = renderHook(usePromptDiscovery, { initialProps: input });
    await waitFor(() => expect(loadOlder).toHaveBeenCalledTimes(1));
    const acceptance = loadOlder.mock.calls[0]![0]!;

    act(() => result.current.cancel());
    await act(async () => release(false));

    expect(acceptance.signal.aborted).toBe(true);
    expect(result.current.status).toBe("cancelled");
  });

  it("treats failure, limits, exhaustion and cancellation as settled", () => {
    const settled: PromptDiscoveryStatus[] = ["error", "limited", "exhausted", "cancelled"];
    const unsettled: PromptDiscoveryStatus[] = ["idle", "loading", "complete"];

    expect(settled.every(isDiscoverySettled)).toBe(true);
    expect(unsettled.some(isDiscoverySettled)).toBe(false);
  });
});
