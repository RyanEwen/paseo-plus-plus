// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { StreamItem } from "@/types/stream";
import { PROMPT_DISCOVERY_PAGE_BUDGET } from "@/timeline/timeline-fetch-policy";
import { createActivePromptPublisher } from "./chat-outline/model";
import type { ChatOutline } from "./chat-outline/use-chat-outline";
import { createPromptReadingPublisher } from "./prompt-reading-position";
import { usePromptNavigationControls } from "./use-prompt-navigation-controls";
import { useStickyPrompt } from "./use-sticky-prompt";

// Characterization of the sticky prompt hook's navigation, discovery, opt-out and epoch
// behaviour, ported from the combined chat outline suite. Pinned-surface outputs live above.
vi.mock("@/constants/platform", () => ({ isWeb: true }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function stickyUser(
  id: string,
  seq: number,
  epoch = "epoch-1",
): Extract<StreamItem, { kind: "user_message" }> {
  return {
    kind: "user_message",
    id,
    text: `Prompt ${seq}\n  preserve whitespace`,
    timestamp: new Date(0),
    timelineCursor: { epoch, seq },
  };
}

function stickyOutline(prompts = [1, 2, 3]): ChatOutline {
  return {
    prompts: prompts.map((seq) => ({
      seq,
      timestamp: new Date(0).toISOString(),
      preview: `Prompt ${seq}`,
    })),
    activePrompt: createActivePromptPublisher(),
    jumpToPrompt: vi.fn(),
    jumpToMessage: vi.fn(),
    reportReadingPosition: vi.fn(),
    isJumping: false,
    jumpError: false,
    indexReady: true,
    indexError: false,
    retryIndex: vi.fn(),
    cancelJump: vi.fn(),
    cancelStickyJump: vi.fn(),
    reportJumpError: vi.fn(),
  };
}

function stickyInput(items: StreamItem[], outline = stickyOutline()) {
  return {
    items,
    epoch: "epoch-1",
    outline,
    indexed: true,
    hasOlder: true,
    loadingOlder: false,
    progressKey: "initial",
    loadOlder: vi.fn(async () => false),
    jumpToLoaded: vi.fn(),
  };
}

describe("sticky user prompt navigation", () => {
  it("resets its selection when the mounted owner moves to another agent", () => {
    const items = [stickyUser("one", 1), stickyUser("two", 2), stickyUser("three", 3)];
    const input = { ...stickyInput(items), scope: "server:draft" };
    const { result, rerender } = renderHook(useStickyPrompt, { initialProps: input });
    act(() => result.current.previous());
    expect(result.current.message).toEqual(items[1]);

    // A draft's handoff to its created agent keeps the timeline mounted; only the scope changes.
    rerender({ ...input, scope: "server:created" });

    expect(result.current.message).toEqual(items[2]);
    expect(result.current.actionVisibleMessageId).toBeUndefined();
  });

  it("defaults to latest, navigates in order and follows incoming prompts intentionally", () => {
    const items = [stickyUser("one", 1), stickyUser("two", 2), stickyUser("three", 3)];
    const input = stickyInput(items);
    const { result, rerender } = renderHook(useStickyPrompt, { initialProps: input });
    expect(result.current.message).toEqual(items[2]);
    expect(result.current.nextDisabled).toBe(true);
    act(() => result.current.previous());
    expect(result.current.message).toEqual(items[1]);
    expect(input.jumpToLoaded).toHaveBeenLastCalledWith("two", "pinned");
    const assistant: StreamItem = {
      kind: "assistant_message",
      id: "assistant",
      text: "Reply",
      timestamp: new Date(0),
    };
    rerender({ ...input, items: [...items, assistant, stickyUser("four", 4)] });
    expect(result.current.message).toEqual(items[1]);
    act(() => result.current.previous());
    expect(result.current.message).toEqual(items[0]);
    expect(result.current.previousDisabled).toBe(true);
    act(() => result.current.next());
    expect(result.current.message).toEqual(items[1]);
    act(() => result.current.followLatest());
    expect(result.current.message?.id).toBe("four");
    rerender({ ...input, items: [...items, stickyUser("five", 5)] });
    expect(result.current.message?.id).toBe("five");
  });

  it("holds the selection through an unloaded jump, reports failure and retries", async () => {
    const newest = stickyUser("three", 3);
    const input = stickyInput([newest]);
    const { result, rerender } = renderHook(useStickyPrompt, { initialProps: input });
    act(() => result.current.previous());
    expect(input.outline.jumpToPrompt).toHaveBeenCalledWith(2, {
      scroll: true,
      source: "sticky",
      placement: "pinned",
    });
    expect(result.current.busy).toBe(true);
    expect(result.current.message).toEqual(newest);
    rerender({ ...input, outline: { ...input.outline, jumpError: true } });
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.busy).toBe(false);
    rerender(input);
    act(() => result.current.retry());
    const older = stickyUser("two", 2);
    rerender({ ...input, items: [older, newest] });
    await waitFor(() => expect(result.current.message).toEqual(older));
    expect(result.current.busy).toBe(false);
  });

  it("preserves complete text and attachment identity and isolates independent panes", () => {
    const message = {
      ...stickyUser("one", 1),
      images: [{ id: "image" }],
      attachments: [{ id: "file" }],
    } as unknown as Extract<StreamItem, { kind: "user_message" }>;
    const input = stickyInput([message], stickyOutline([1]));
    const first = renderHook(useStickyPrompt, { initialProps: input });
    const second = renderHook(useStickyPrompt, {
      initialProps: stickyInput([], stickyOutline([])),
    });
    expect(first.result.current.message).toBe(message);
    expect(first.result.current.message?.images).toBe(message.images);
    expect(first.result.current.message?.attachments).toBe(message.attachments);
    expect(second.result.current.message).toBeUndefined();
    expect(second.result.current.previousDisabled).toBe(true);
    expect(second.result.current.nextDisabled).toBe(true);
  });

  it("does not loop when index-free pagination fails without advancing", async () => {
    const loadOlder = vi.fn(async () => true);
    const input = {
      ...stickyInput([stickyUser("three", 3)], stickyOutline([])),
      indexed: false,
      loadOlder,
    };
    const { result, rerender } = renderHook(useStickyPrompt, { initialProps: input });
    act(() => result.current.previous());
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(loadOlder).toHaveBeenCalledTimes(1);
    const older = stickyUser("one", 1);
    rerender({ ...input, items: [older, ...input.items] });
    act(() => result.current.retry());
    expect(result.current.message).toEqual(older);
  });
});

describe("sticky pagination across hidden history", () => {
  it("continues when the cursor advances without adding a visible prompt", async () => {
    const firstPage = deferred<boolean>();
    const secondPage = deferred<boolean>();
    const loadOlder = vi
      .fn()
      .mockReturnValueOnce(firstPage.promise)
      .mockReturnValueOnce(secondPage.promise);
    const input = {
      ...stickyInput([stickyUser("three", 3)], stickyOutline([])),
      indexed: false,
      loadOlder,
    };
    const { result, rerender } = renderHook(useStickyPrompt, { initialProps: input });
    act(() => result.current.previous());
    expect(loadOlder).toHaveBeenCalledTimes(1);
    // A hidden system/tool page moves the authoritative cursor without adding a user row.
    rerender({ ...input, progressKey: "older-page-1" });
    await act(async () => firstPage.resolve(true));
    await waitFor(() => expect(loadOlder).toHaveBeenCalledTimes(2));
    const older = stickyUser("one", 1);
    rerender({ ...input, progressKey: "older-page-2", items: [older, ...input.items] });
    await act(async () => secondPage.resolve(true));
    await waitFor(() => expect(result.current.message).toEqual(older));
    expect(result.current.error).toBe(false);
    expect(result.current.busy).toBe(false);
  });
});

/** A deferred page isolates navigation intent from the timeline owner's delivery. */
describe("initial prompt discovery", () => {
  const assistant = {
    kind: "assistant_message",
    id: "assistant",
    text: "Tool-only tail",
    timestamp: new Date(0),
  } as const;

  it("discovers the latest prompt past two pages without a user row", async () => {
    const pages = [deferred<boolean>(), deferred<boolean>(), deferred<boolean>()];
    const loadOlder = vi
      .fn()
      .mockReturnValueOnce(pages[0].promise)
      .mockReturnValueOnce(pages[1].promise)
      .mockReturnValueOnce(pages[2].promise);
    const input = { ...stickyInput([assistant], stickyOutline([])), indexed: false, loadOlder };
    const { result, rerender } = renderHook(useStickyPrompt, { initialProps: input });
    expect(result.current.message).toBeUndefined();
    expect(result.current.busy).toBe(true);
    rerender({ ...input, progressKey: "page-1" });
    await act(async () => pages[0].resolve(true));
    await waitFor(() => expect(loadOlder).toHaveBeenCalledTimes(2));
    rerender({ ...input, progressKey: "page-2" });
    await act(async () => pages[1].resolve(true));
    await waitFor(() => expect(loadOlder).toHaveBeenCalledTimes(3));
    const user = stickyUser("latest", 1);
    rerender({ ...input, progressKey: "page-3", items: [user, assistant] });
    await act(async () => pages[2].resolve(true));
    expect(result.current.message).toEqual(user);
    expect(result.current.busy).toBe(false);
    expect(input.jumpToLoaded).not.toHaveBeenCalled();
  });

  it("stops when history is exhausted", async () => {
    const page = deferred<boolean>();
    const loadOlder = vi.fn((_acceptance?: { signal: AbortSignal }) => page.promise);
    const input = { ...stickyInput([assistant], stickyOutline([])), indexed: false, loadOlder };
    const { result, rerender } = renderHook(useStickyPrompt, { initialProps: input });
    rerender({ ...input, hasOlder: false });
    await act(async () => page.resolve(true));
    expect(result.current.discoveryStatus).toBe("exhausted");
    expect(result.current.busy).toBe(false);
    expect(loadOlder).toHaveBeenCalledTimes(1);
  });

  it("shows failure without a prompt and retries the page", async () => {
    const loadOlder = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    const input = { ...stickyInput([assistant], stickyOutline([])), indexed: false, loadOlder };
    const { result } = renderHook(useStickyPrompt, { initialProps: input });
    await waitFor(() => expect(result.current.error).toBe(true));
    act(() => result.current.retry());
    await waitFor(() => expect(loadOlder).toHaveBeenCalledTimes(2));
    expect(result.current.message).toBeUndefined();
    await waitFor(() => expect(result.current.error).toBe(true));
  });

  it("cancels page acceptance and ignores its late completion", async () => {
    const page = deferred<boolean>();
    const loadOlder = vi.fn((_acceptance?: { signal: AbortSignal }) => page.promise);
    const input = { ...stickyInput([assistant], stickyOutline([])), indexed: false, loadOlder };
    const { result } = renderHook(useStickyPrompt, { initialProps: input });
    const acceptance = loadOlder.mock.calls[0]![0] as unknown as { signal: AbortSignal };
    act(() => result.current.cancel());
    expect(acceptance.signal.aborted).toBe(true);
    await act(async () => page.resolve(true));
    expect(loadOlder).toHaveBeenCalledTimes(1);
    expect(result.current.discoveryStatus).toBe("cancelled");
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toBe(false);
  });

  it("limits a progressing history and lets the user explicitly continue", async () => {
    const pages = Array.from({ length: PROMPT_DISCOVERY_PAGE_BUDGET }, () => deferred<boolean>());
    let pageIndex = 0;
    const loadOlder = vi.fn(() => pages[pageIndex++].promise);
    const input = { ...stickyInput([assistant], stickyOutline([])), indexed: false, loadOlder };
    const { result, rerender } = renderHook(useStickyPrompt, { initialProps: input });
    for (let index = 0; index < PROMPT_DISCOVERY_PAGE_BUDGET; index += 1) {
      await waitFor(() => expect(loadOlder).toHaveBeenCalledTimes(index + 1));
      rerender({ ...input, progressKey: `page-${index + 1}` });
      await act(async () => pages[index].resolve(true));
    }
    expect(result.current.discoveryStatus).toBe("limited");
    expect(loadOlder).toHaveBeenCalledTimes(PROMPT_DISCOVERY_PAGE_BUDGET);
    loadOlder.mockImplementation(async () => false);
    act(() => result.current.retry());
    await waitFor(() => expect(loadOlder).toHaveBeenCalledTimes(PROMPT_DISCOVERY_PAGE_BUDGET + 1));
  });

  it("retries latest indexed content without loading a window before any prompt is loaded", async () => {
    const outline = stickyOutline([1]);
    const latest = stickyUser("latest", 1);
    const fetchPrompt = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(latest);
    const input = { ...stickyInput([assistant], outline), fetchPrompt };
    const { result } = renderHook(useStickyPrompt, { initialProps: input });
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(fetchPrompt).toHaveBeenCalledWith(1);
    expect(outline.jumpToPrompt).not.toHaveBeenCalled();
    expect(input.loadOlder).not.toHaveBeenCalled();
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.message).toEqual(latest));
    expect(fetchPrompt).toHaveBeenCalledTimes(2);
    expect(outline.jumpToPrompt).not.toHaveBeenCalled();
    expect(input.loadOlder).not.toHaveBeenCalled();
    expect(result.current.error).toBe(false);
  });
});

describe("arrow navigation through passing prompts", () => {
  it("keeps an arrow target selected while smooth scrolling passes other prompts", () => {
    const users = [stickyUser("first", 1), stickyUser("second", 2), stickyUser("third", 3)];
    const reading = createPromptReadingPublisher();
    const input = { ...stickyInput(users, stickyOutline([1, 2, 3])), reading };
    const { result } = renderHook(useStickyPrompt, { initialProps: input });
    act(() => reading.publish({ rowId: users[2]!.id }));
    act(() => result.current.activate("third", -1));
    act(() => reading.publish({ rowId: "third", navigating: true }));
    expect(result.current.message?.id).toBe("second");
    act(() => reading.publish({ rowId: "second", navigating: false }));
    expect(result.current.message?.id).toBe("second");
    expect(input.jumpToLoaded).toHaveBeenCalledWith("second", "pinned");
  });
});

it("reads an unloaded active prompt without replacing or scrolling the viewport, and retries", async () => {
  const olderAnswer = {
    kind: "assistant_message" as const,
    id: "older-answer",
    text: "older response",
    timestamp: new Date(2),
    timelineCursor: { epoch: "epoch-1", seq: 2 },
  };
  const latest = stickyUser("latest", 3);
  const loadedOlder = stickyUser("old", 1);
  const reading = createPromptReadingPublisher();
  const content = deferred<typeof loadedOlder>();
  const fetchPrompt = vi
    .fn()
    .mockRejectedValueOnce(new Error("network"))
    .mockReturnValueOnce(content.promise);
  const input = {
    ...stickyInput([olderAnswer, latest], stickyOutline([1, 3])),
    reading,
    fetchPrompt,
  };
  const { result } = renderHook(useStickyPrompt, { initialProps: input });
  act(() => reading.publish({ rowId: olderAnswer.id }));
  await waitFor(() => expect(result.current.error).toBe(true));
  expect(result.current.message).toBeUndefined();
  act(() => result.current.retry());
  await waitFor(() => expect(fetchPrompt).toHaveBeenCalledTimes(2));
  const readingBeforeContent = reading.getSnapshot();
  await act(async () => content.resolve(loadedOlder));
  expect(reading.getSnapshot()).toBe(readingBeforeContent);
  expect(reading.getSnapshot()).toMatchObject({
    manual: true,
    following: false,
    navigating: false,
  });
  expect(input.items).toEqual([olderAnswer, latest]);
  expect(result.current.message).toEqual(loadedOlder);
  expect(result.current.error).toBe(false);
  expect(input.outline.jumpToPrompt).not.toHaveBeenCalled();
  expect(input.jumpToLoaded).not.toHaveBeenCalled();
  act(() => result.current.next());
  expect(input.jumpToLoaded).toHaveBeenCalledWith("latest", "pinned");
});

it("ignores a late content-only read after return to latest and isolates new panes", async () => {
  const answer = {
    kind: "assistant_message" as const,
    id: "answer",
    text: "response",
    timestamp: new Date(2),
    timelineCursor: { epoch: "epoch-1", seq: 2 },
  };
  const latest = stickyUser("latest", 3);
  const old = stickyUser("old", 1);
  const content = deferred<typeof old>();
  const reading = createPromptReadingPublisher();
  const input = {
    ...stickyInput([answer, latest], stickyOutline([1, 3])),
    reading,
    fetchPrompt: vi.fn(() => content.promise),
  };
  const { result } = renderHook(useStickyPrompt, { initialProps: input });
  act(() => reading.publish({ rowId: answer.id }));
  await waitFor(() => expect(input.fetchPrompt).toHaveBeenCalledTimes(1));
  act(() => {
    result.current.followLatest();
    reading.publish({ rowId: latest.id });
  });
  await act(async () => content.resolve(old));
  expect(result.current.message?.id).toBe("latest");
  expect(result.current.error).toBe(false);
  const other = renderHook(useStickyPrompt, {
    initialProps: { ...input, reading: createPromptReadingPublisher() },
  });
  expect(other.result.current.message?.id).toBe("latest");
});

it("uses authoritative source positions for projected Markdown reading rows", () => {
  const older = stickyUser("older", 1);
  const latest = stickyUser("latest", 3);
  const reading = createPromptReadingPublisher();
  const input = { ...stickyInput([older, latest], stickyOutline([1, 3])), reading };
  const { result } = renderHook(useStickyPrompt, { initialProps: input });
  act(() =>
    reading.publish({
      rowId: "projected-markdown-block",
      navigating: false,
      following: false,
      manual: true,
      seq: 2,
    }),
  );
  expect(result.current.message?.id).toBe("older");
  act(() =>
    reading.publish({
      rowId: "same-block",
      navigating: false,
      following: true,
      manual: false,
      seq: 2,
    }),
  );
  expect(result.current.message?.id).toBe("latest");
});

it("does not transfer an arrow selection to a different reading-edge prompt after a clamped jump", () => {
  const users = [stickyUser("first", 1), stickyUser("second", 2), stickyUser("third", 3)];
  const reading = createPromptReadingPublisher();
  const input = { ...stickyInput(users, stickyOutline([1, 2, 3])), reading };
  const { result } = renderHook(useStickyPrompt, { initialProps: input });
  act(() => result.current.activate("third", -1));
  act(() =>
    reading.publish({ rowId: "first", navigating: false, following: false, manual: false, seq: 1 }),
  );
  expect(result.current.message?.id).toBe("second");
  act(() =>
    reading.publish({ rowId: "first", navigating: false, following: false, manual: true, seq: 1 }),
  );
  expect(result.current.message?.id).toBe("first");
});
it("preserves known attachment content when its indexed prompt leaves the loaded window", async () => {
  const old = {
    ...stickyUser("old", 1),
    images: [{ id: "image" }],
    attachments: [{ id: "file" }],
  } as unknown as Extract<StreamItem, { kind: "user_message" }>;
  const latest = stickyUser("latest", 3);
  const reading = createPromptReadingPublisher();
  const fetchPrompt = vi.fn();
  const input = { ...stickyInput([old, latest], stickyOutline([1, 3])), reading, fetchPrompt };
  const { result, rerender } = renderHook(useStickyPrompt, { initialProps: input });
  rerender({ ...input, items: [latest] });
  act(() =>
    reading.publish({
      rowId: "projected-old-response",
      navigating: false,
      following: false,
      manual: true,
      seq: 2,
    }),
  );
  await waitFor(() => expect(result.current.message?.id).toBe("old"));
  expect(result.current.message?.images).toBe(old.images);
  expect(result.current.message?.attachments).toBe(old.attachments);
  expect(fetchPrompt).not.toHaveBeenCalled();
});

it("keeps original prompt controls stable during assistant streaming and updates when user targets change", () => {
  const first = stickyUser("first", 1);
  const answer = {
    id: "answer",
    kind: "assistant_message" as const,
    text: "first chunk",
    timestamp: new Date(2),
  };
  const input = stickyInput([first, answer], stickyOutline([1]));
  const { result, rerender } = renderHook(
    (props) => usePromptNavigationControls(useStickyPrompt(props)),
    { initialProps: input },
  );
  const initial = result.current;
  rerender({ ...input, items: [first, { ...answer, text: "continued streaming chunk" }] });
  expect(result.current).toBe(initial);
  rerender({
    ...input,
    items: [first, answer, stickyUser("next", 3)],
    outline: stickyOutline([1, 3]),
  });
  expect(result.current).not.toBe(initial);
  expect(result.current.targetIds).toEqual(["first", "next"]);
});

describe("sticky optional feature", () => {
  it("does no discovery or navigation while disabled and restarts when enabled", async () => {
    const input = { ...stickyInput([], stickyOutline([])), indexed: false, enabled: false };
    const { result, rerender } = renderHook(useStickyPrompt, { initialProps: input });
    act(() => {
      result.current.retry();
      result.current.previous();
      result.current.reviewReading();
      result.current.followLatest();
    });
    expect(input.loadOlder).not.toHaveBeenCalled();
    expect(input.outline.jumpToPrompt).not.toHaveBeenCalled();
    expect(input.outline.cancelJump).not.toHaveBeenCalled();
    rerender({ ...input, enabled: true });
    await waitFor(() => expect(input.loadOlder).toHaveBeenCalledTimes(1));
  });
  it("invalidates held discovery without applying it or fetching again", async () => {
    const page = deferred<boolean>();
    const loadOlder = vi.fn((_acceptance?: { signal: AbortSignal }) => page.promise);
    const input = {
      ...stickyInput([], stickyOutline([])),
      indexed: false,
      loadOlder,
      enabled: true,
    };
    const { rerender } = renderHook(useStickyPrompt, { initialProps: input });
    const acceptance = loadOlder.mock.calls[0]![0]!;
    rerender({ ...input, enabled: false });
    expect(acceptance.signal.aborted).toBe(true);
    expect(input.outline.cancelStickyJump).toHaveBeenCalledTimes(1);
    expect(input.outline.cancelJump).not.toHaveBeenCalled();
    await act(async () => page.resolve(true));
    expect(loadOlder).toHaveBeenCalledTimes(1);
  });
  it("does not read missing content when disabled", async () => {
    const user = stickyUser("latest", 3);
    const answer = {
      kind: "assistant_message",
      id: "old-answer",
      text: "answer",
      timestamp: new Date(0),
      timelineCursor: { epoch: "epoch-1", seq: 2 },
    } as const;
    const reading = createPromptReadingPublisher();
    reading.publish({
      rowId: answer.id,
      navigating: false,
      following: false,
      manual: true,
      seq: 2,
    });
    const fetchPrompt = vi.fn(() => deferred<ReturnType<typeof stickyUser>>().promise);
    const input = {
      ...stickyInput([answer, user], stickyOutline([1, 3])),
      enabled: false,
      reading,
      fetchPrompt,
    };
    renderHook(useStickyPrompt, { initialProps: input });
    expect(fetchPrompt).not.toHaveBeenCalled();
  });
  it("cancels late content reads on opt-out and preserves loaded data", async () => {
    const user = { ...stickyUser("latest", 3), attachments: [{ id: "file" }] } as ReturnType<
      typeof stickyUser
    >;
    const answer = {
      kind: "assistant_message",
      id: "old-answer",
      text: "answer",
      timestamp: new Date(0),
      timelineCursor: { epoch: "epoch-1", seq: 2 },
    } as const;
    const reading = createPromptReadingPublisher();
    reading.publish({
      rowId: answer.id,
      navigating: false,
      following: false,
      manual: true,
      seq: 2,
    });
    const page = deferred<ReturnType<typeof stickyUser>>();
    const fetchPrompt = vi.fn(() => page.promise);
    const input = {
      ...stickyInput([answer, user], stickyOutline([1, 3])),
      enabled: true,
      reading,
      fetchPrompt,
    };
    const { result, rerender } = renderHook(useStickyPrompt, { initialProps: input });
    expect(fetchPrompt).toHaveBeenCalledTimes(1);
    rerender({ ...input, enabled: false });
    await act(async () => page.resolve(stickyUser("old", 1)));
    expect(result.current.message).toBe(user);
    expect(result.current.message?.attachments).toBe(user.attachments);
    act(() => reading.publish({ rowId: user.id, navigating: false, following: true }));
    rerender({ ...input, enabled: true });
    expect(result.current.message).toBe(user);
    expect(fetchPrompt).toHaveBeenCalledTimes(1);
  });
});
describe("return to the pinned prompt", () => {
  it("reveals this loaded prompt rather than an adjacent one and retains it through incoming prompts", () => {
    const latest = stickyUser("three", 3);
    const reading = createPromptReadingPublisher();
    const input = { ...stickyInput([latest]), reading };
    const { result, rerender } = renderHook(useStickyPrompt, { initialProps: input });
    act(() => result.current.reveal());
    expect(input.jumpToLoaded).toHaveBeenCalledWith(latest.id, "original");
    expect(input.outline.jumpToPrompt).not.toHaveBeenCalled();
    act(() =>
      reading.publish({
        rowId: latest.id,
        navigating: false,
        following: false,
        manual: false,
        seq: 3,
      }),
    );
    const incoming = stickyUser("four", 4);
    rerender({ ...input, items: [latest, incoming], outline: stickyOutline([1, 2, 3, 4]) });
    expect(result.current.message?.id).toBe(latest.id);
    act(() => result.current.followLatest());
    expect(result.current.message?.id).toBe(incoming.id);
  });
  it("loads the indexed current prompt when only its response is in the window", async () => {
    const old = stickyUser("one", 1);
    const latest = stickyUser("three", 3);
    const answer = {
      kind: "assistant_message",
      id: "answer",
      text: "response",
      timestamp: new Date(0),
      timelineCursor: { epoch: "epoch-1", seq: 2 },
    } as const;
    const reading = createPromptReadingPublisher();
    reading.publish({
      rowId: answer.id,
      navigating: false,
      following: false,
      manual: true,
      seq: 2,
    });
    const input = {
      ...stickyInput([answer, latest], stickyOutline([1, 3])),
      reading,
      fetchPrompt: vi.fn(async () => old),
    };
    const { result, rerender } = renderHook(useStickyPrompt, { initialProps: input });
    await waitFor(() => expect(result.current.message?.id).toBe(old.id));
    act(() => result.current.reveal());
    expect(input.outline.jumpToPrompt).toHaveBeenCalledWith(1, {
      scroll: true,
      source: "sticky",
      placement: "original",
    });
    expect(result.current.busy).toBe(true);
    act(() => result.current.reveal());
    expect(input.outline.jumpToPrompt).toHaveBeenCalledTimes(1);
    rerender({ ...input, items: [old, answer, latest] });
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(result.current.message?.id).toBe(old.id);
  });
  it("does not navigate from an empty, loading or disabled surface", () => {
    const user = stickyUser("three", 3);
    const input = stickyInput([user]);
    const { result, rerender } = renderHook(useStickyPrompt, {
      initialProps: { ...input, enabled: true },
    });
    rerender({ ...input, enabled: true, outline: { ...input.outline, isJumping: true } });
    act(() => result.current.reveal());
    rerender({ ...input, enabled: false });
    act(() => result.current.reveal());
    expect(input.jumpToLoaded).not.toHaveBeenCalled();
    const empty = renderHook(useStickyPrompt, { initialProps: stickyInput([], stickyOutline([])) });
    act(() => empty.result.current.reveal());
    expect(empty.result.current.message).toBeUndefined();
  });
});

describe("prompt ownership across authoritative epochs", () => {
  it("clears an earlier selection and pending jump without scrolling the retained viewport", () => {
    const input = stickyInput(
      [stickyUser("one", 1), stickyUser("three", 3)],
      stickyOutline([0, 1, 3]),
    );
    const { result, rerender } = renderHook(useStickyPrompt, { initialProps: input });
    act(() => result.current.previous());
    expect(result.current.message?.id).toBe("one");
    act(() => result.current.previous());
    expect(result.current.busy).toBe(true);
    const cancellationCount = vi.mocked(input.outline.cancelStickyJump).mock.calls.length;
    const latest = { ...stickyUser("three", 3, "epoch-2"), text: "Replacement latest" };
    rerender({ ...input, epoch: "epoch-2", items: [stickyUser("one", 1, "epoch-2"), latest] });
    expect(result.current.message).toEqual(latest);
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toBe(false);
    expect(input.outline.cancelStickyJump).toHaveBeenCalledTimes(cancellationCount + 1);
    expect(input.jumpToLoaded).toHaveBeenCalledTimes(1);
  });
});

describe("prompt work across stream ticks", () => {
  it("keeps prompt targets when only the streaming head changes", () => {
    const user = stickyUser("one", 1);
    const promptRows = [user];
    const input = { ...stickyInput([user], stickyOutline([1])), promptRows };
    const { result, rerender } = renderHook(useStickyPrompt, { initialProps: input });
    const initial = result.current.targets;
    const streamed: StreamItem = {
      kind: "assistant_message",
      id: "live",
      text: "token",
      timestamp: new Date(0),
    };

    rerender({ ...input, items: [user, streamed] });

    expect(result.current.targets).toBe(initial);
  });
});
