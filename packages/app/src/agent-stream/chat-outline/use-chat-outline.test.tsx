import {
  rawPromptLookup,
  requestPromptFixture,
} from "@/timeline/canonical-prompt-context.test-fixture";
import {
  reconcileCanonicalSourceMetadata,
  resolveCanonicalSourceMetadata,
  hasCanonicalSourceEvidence,
  EMPTY_SOURCE_METADATA,
  type AcceptedCanonicalSources,
} from "@/timeline/canonical-source-metadata";
import {
  resolveOrdinaryPromptContext,
  resolveKnownPromptContext,
  canCoalesceCanonicalSource,
  planCanonicalReadingAttempt,
} from "@/timeline/canonical-reading-source";
import {
  createCanonicalPromptContexts,
  canonicalPromptSourceKey,
} from "@/timeline/canonical-prompt-context";
import { useCanonicalPromptContext } from "@/timeline/use-canonical-prompt-context";
import { useNativeReadingRefresh } from "../native-sticky-viewport";
import { resolveActualNativeReading } from "../native-actual-row-model";
import { ActualPromptRowsContext, ActualPromptRowsProvider } from "../actual-prompt-rows";
import React, { useContext, type ReactNode } from "react";
import { useNavigationActionVisibility } from "../use-navigation-action-visibility";
// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamViewportHandle } from "../strategy";
import { PROMPT_DISCOVERY_PAGE_BUDGET } from "../use-prompt-discovery";
import { createPromptReadingPublisher } from "../prompt-reading-position";
import { usePromptNavigationControls } from "../use-prompt-navigation-controls";
import * as protocolSchemas from "@getpaseo/protocol/messages";
import { createTimelineRequestLedger } from "../../../e2e/support/helpers/timeline-request-ledger";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  fetchReadingPromptContext,
  childContextPageReader,
  normalContextPageReader,
  type ContextPage,
  type ContextEntry,
} from "../fetch-reading-prompt-context";
import type { UserPrompt } from "../sticky-prompt-model";
import { useReadingPrompt } from "../use-reading-prompt";
import { useStickyPrompt } from "../use-sticky-prompt";
import type { StreamItem } from "@/types/stream";
import type { TimelinePageAcceptance } from "@/timeline/fetch-viewed-timeline-page";
import type { ChatOutline } from "./use-chat-outline";
import { shouldIndexUserPrompts, createActivePromptPublisher } from "./model";
import { useChatOutline } from "./use-chat-outline";

const runtime = vi.hoisted(() => ({
  listAgentTimelinePrompts: vi.fn(),
  fetchAgentTimeline: vi.fn(),
  subscribeAgentTimeline: vi.fn(() => {
    throw new Error("The outline must reuse the viewed timeline");
  }),
}));

vi.mock("@/constants/platform", () => ({ isWeb: true }));
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({
    getClient: () => runtime,
    fetchAgentTimeline: runtime.fetchAgentTimeline,
  }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("useChatOutline", () => {
  beforeEach(() => {
    runtime.listAgentTimelinePrompts.mockReset();
    runtime.fetchAgentTimeline.mockReset();
    runtime.subscribeAgentTimeline.mockClear();
  });

  it("routes loaded pinned placement while default outline navigation keeps the original landing", () => {
    const scrollToMessage = vi.fn();
    const viewportRef = createRef<StreamViewportHandle>();
    viewportRef.current = {
      scrollToMessage,
      scrollToBottom: vi.fn(),
      prepareForViewportChange: vi.fn(),
    };
    const { result } = renderHook(() =>
      useChatOutline({
        agentId: "agent-1",
        serverId: "server-1",
        timelineEpoch: "epoch-1",
        tail: [stickyUser("one", 1)],
        head: [],
        enabled: false,
        viewportRef,
        onJumpError: vi.fn(),
      }),
    );
    act(() => result.current.jumpToPrompt(1, { source: "sticky", placement: "pinned" }));
    expect(scrollToMessage).toHaveBeenLastCalledWith("one", undefined, "pinned");
    act(() => result.current.jumpToMessage("one"));
    expect(scrollToMessage).toHaveBeenLastCalledWith("one");
    act(() => result.current.jumpToPrompt(1, { scroll: false, placement: "pinned" }));
    expect(scrollToMessage).toHaveBeenCalledTimes(2);
  });

  it("retains unloaded pinned placement until its authoritative row loads", async () => {
    runtime.listAgentTimelinePrompts.mockResolvedValue({
      epoch: "epoch-1",
      prompts: [{ seq: 2, timestamp: new Date(2).toISOString(), preview: "two" }],
    });
    const held = deferred<void>();
    runtime.fetchAgentTimeline.mockReturnValue(held.promise);
    const scrollToMessage = vi.fn();
    const viewportRef = createRef<StreamViewportHandle>();
    viewportRef.current = {
      scrollToMessage,
      scrollToBottom: vi.fn(),
      prepareForViewportChange: vi.fn(),
    };
    const { result, rerender } = renderHook(
      ({ tail }) =>
        useChatOutline({
          agentId: "agent-1",
          serverId: "server-1",
          timelineEpoch: "epoch-1",
          tail,
          head: [],
          enabled: true,
          viewportRef,
          onJumpError: vi.fn(),
        }),
      { initialProps: { tail: [stickyUser("one", 1)] as StreamItem[] } },
    );
    await waitFor(() => expect(result.current.prompts).toHaveLength(1));
    act(() => result.current.jumpToPrompt(2, { source: "sticky", placement: "pinned" }));
    expect(scrollToMessage).not.toHaveBeenCalled();
    rerender({ tail: [stickyUser("one", 1), stickyUser("two", 2)] });
    await waitFor(() => expect(scrollToMessage).toHaveBeenCalledWith("two", undefined, "pinned"));
    await act(async () => held.resolve());
    expect(scrollToMessage).toHaveBeenCalledTimes(1);
    expect(result.current.jumpError).toBe(false);
  });

  it("waits for a served timeline before requesting its prompt index", async () => {
    runtime.listAgentTimelinePrompts.mockResolvedValue({ epoch: "epoch-1", prompts: [] });
    const viewportRef = createRef<StreamViewportHandle>();
    const { rerender } = renderHook(
      ({ agentId, timelineEpoch }) =>
        useChatOutline({
          agentId,
          serverId: "server-1",
          timelineEpoch,
          tail: [],
          head: [],
          enabled: true,
          viewportRef,
          onJumpError: vi.fn(),
        }),
      { initialProps: { agentId: "draft_msg_1", timelineEpoch: null as string | null } },
    );

    expect(runtime.listAgentTimelinePrompts).not.toHaveBeenCalled();

    rerender({ agentId: "agent-1", timelineEpoch: "epoch-1" });
    await waitFor(() => expect(runtime.listAgentTimelinePrompts).toHaveBeenCalledTimes(1));
    expect(runtime.listAgentTimelinePrompts).toHaveBeenCalledWith("agent-1");
  });

  it("drops a late prompt index after the authoritative timeline epoch changes", async () => {
    const first = deferred<{ epoch: string; prompts: [] }>();
    const second = deferred<{
      epoch: string;
      prompts: Array<{ seq: number; timestamp: string; preview: string }>;
    }>();
    runtime.listAgentTimelinePrompts
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const viewportRef = createRef<StreamViewportHandle>();
    const { result, rerender } = renderHook(
      ({ timelineEpoch }) =>
        useChatOutline({
          agentId: "agent-1",
          serverId: "server-1",
          timelineEpoch,
          tail: [],
          head: [],
          enabled: true,
          viewportRef,
          onJumpError: vi.fn(),
        }),
      { initialProps: { timelineEpoch: "epoch-1" } },
    );
    await waitFor(() => expect(runtime.listAgentTimelinePrompts).toHaveBeenCalledTimes(1));

    rerender({ timelineEpoch: "epoch-2" });
    await waitFor(() => expect(runtime.listAgentTimelinePrompts).toHaveBeenCalledTimes(2));
    await act(async () => first.resolve({ epoch: "epoch-1", prompts: [] }));
    expect(result.current.prompts).toEqual([]);

    await act(async () =>
      second.resolve({
        epoch: "epoch-2",
        prompts: [{ seq: 2, timestamp: new Date(2).toISOString(), preview: "current prompt" }],
      }),
    );
    await waitFor(() => {
      expect(result.current.prompts).toHaveLength(1);
    });
    expect(result.current.prompts[0]?.seq).toBe(2);
  });

  it("refreshes from viewed user messages without another stream and keeps the newest index", async () => {
    const older = deferred<{
      epoch: string;
      prompts: Array<{ seq: number; timestamp: string; preview: string }>;
    }>();
    const newer = deferred<{
      epoch: string;
      prompts: Array<{ seq: number; timestamp: string; preview: string }>;
    }>();
    runtime.listAgentTimelinePrompts
      .mockResolvedValueOnce({ epoch: "epoch-1", prompts: [] })
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const viewportRef = createRef<StreamViewportHandle>();
    const { result, rerender } = renderHook(
      ({ tail }) =>
        useChatOutline({
          agentId: "agent-1",
          serverId: "server-1",
          timelineEpoch: "epoch-1",
          tail,
          head: [],
          enabled: true,
          viewportRef,
          onJumpError: vi.fn(),
        }),
      { initialProps: { tail: [] as import("@/types/stream").StreamItem[] } },
    );
    await waitFor(() => expect(runtime.listAgentTimelinePrompts).toHaveBeenCalledTimes(1));
    const loadedPrompt = (seq: number): import("@/types/stream").StreamItem => ({
      id: `prompt-${seq}`,
      kind: "user_message",
      text: "live prompt",
      timestamp: new Date(seq),
      timelineCursor: { epoch: "epoch-1", seq },
    });
    rerender({ tail: [loadedPrompt(2)] });
    await waitFor(() => expect(runtime.listAgentTimelinePrompts).toHaveBeenCalledTimes(2));
    rerender({ tail: [loadedPrompt(2), loadedPrompt(3)] });
    await waitFor(() => expect(runtime.listAgentTimelinePrompts).toHaveBeenCalledTimes(3));
    await act(async () =>
      newer.resolve({
        epoch: "epoch-1",
        prompts: [{ seq: 3, timestamp: new Date(3).toISOString(), preview: "newer" }],
      }),
    );
    await act(async () =>
      older.resolve({
        epoch: "epoch-1",
        prompts: [{ seq: 2, timestamp: new Date(2).toISOString(), preview: "older" }],
      }),
    );

    expect(result.current.prompts.map((prompt) => prompt.seq)).toEqual([3]);
    expect(runtime.subscribeAgentTimeline).not.toHaveBeenCalled();
  });

  it("refreshes after reconnect catch-up and visibility changes without reacting to assistant chunks", async () => {
    runtime.listAgentTimelinePrompts.mockResolvedValue({
      epoch: "epoch-1",
      prompts: [{ seq: 1, timestamp: new Date(1).toISOString(), preview: "Unloaded prompt" }],
    });
    const viewportRef = createRef<StreamViewportHandle>();
    const { result, rerender } = renderHook(
      ({ enabled, head, timelineEpoch }) =>
        useChatOutline({
          agentId: "agent-1",
          serverId: "server-1",
          tail: [],
          head,
          timelineEpoch,
          enabled,
          viewportRef,
          mountedHistoryMessageIds: new Set(),
          onJumpError: vi.fn(),
        }),
      {
        initialProps: {
          enabled: true,
          head: [] as import("@/types/stream").StreamItem[],
          timelineEpoch: "epoch-1",
        },
      },
    );
    await waitFor(() => expect(result.current.prompts[0]?.preview).toBe("Unloaded prompt"));
    rerender({
      enabled: true,
      head: [
        {
          id: "assistant",
          kind: "assistant_message",
          text: "chunk",
          timestamp: new Date(),
          timelineCursor: { epoch: "epoch-1", seq: 2 },
        },
      ],
      timelineEpoch: "epoch-1",
    });
    expect(runtime.listAgentTimelinePrompts).toHaveBeenCalledTimes(1);
    rerender({ enabled: false, head: [], timelineEpoch: "epoch-1" });
    expect(result.current.prompts).toEqual([]);
    // The viewed model publishes the catch-up from the reconnected transport.
    runtime.listAgentTimelinePrompts.mockResolvedValue({
      epoch: "epoch-2",
      prompts: [{ seq: 1, timestamp: new Date(2).toISOString(), preview: "Replaced conversation" }],
    });
    rerender({
      enabled: true,
      head: [
        {
          id: "reconnected-user",
          kind: "user_message",
          text: "Replaced conversation",
          timestamp: new Date(2),
          timelineCursor: { epoch: "epoch-2", seq: 1 },
        },
      ],
      timelineEpoch: "epoch-2",
    });
    await waitFor(() => expect(result.current.prompts[0]?.preview).toBe("Replaced conversation"));
    expect(runtime.listAgentTimelinePrompts).toHaveBeenCalledTimes(2);
    expect(runtime.subscribeAgentTimeline).not.toHaveBeenCalled();
  });

  it("reports a failed unloaded prompt jump", async () => {
    runtime.listAgentTimelinePrompts.mockResolvedValue({
      epoch: "epoch-1",
      prompts: [{ seq: 1, timestamp: new Date(1).toISOString(), preview: "prompt" }],
    });
    runtime.fetchAgentTimeline.mockRejectedValue(new Error("disconnected"));
    const onJumpError = vi.fn();
    const viewportRef = createRef<StreamViewportHandle>();
    const { result } = renderHook(() =>
      useChatOutline({
        agentId: "agent-1",
        serverId: "server-1",
        timelineEpoch: "epoch-1",
        tail: [],
        head: [],
        enabled: true,
        viewportRef,
        onJumpError,
      }),
    );
    await waitFor(() => expect(result.current.prompts).toHaveLength(1));
    await act(async () => result.current.jumpToPrompt(1));

    await waitFor(() => expect(onJumpError).toHaveBeenCalledOnce());
  });

  it("reveals an already-loaded older prompt before scrolling to it", async () => {
    runtime.listAgentTimelinePrompts.mockResolvedValue({
      epoch: "epoch-1",
      prompts: [{ seq: 1, timestamp: new Date(1).toISOString(), preview: "prompt" }],
    });
    const scrollToMessage = vi.fn();
    const revealLoadedMessage = vi.fn(() => true);
    const viewport: StreamViewportHandle = {
      scrollToBottom: vi.fn(),
      prepareForViewportChange: vi.fn(),
      scrollToMessage,
    };
    const viewportRef = { current: viewport };
    const tail = [
      {
        id: "older-prompt",
        kind: "user_message" as const,
        text: "prompt",
        timestamp: new Date(1),
        timelineCursor: { epoch: "epoch-1", seq: 1 },
      },
    ];
    const { result, rerender } = renderHook(
      ({ mountedHistoryMessageIds }) =>
        useChatOutline({
          agentId: "agent-1",
          serverId: "server-1",
          timelineEpoch: "epoch-1",
          tail,
          head: [],
          enabled: true,
          viewportRef,
          onJumpError: vi.fn(),
          mountedHistoryMessageIds,
          revealLoadedMessage,
        }),
      { initialProps: { mountedHistoryMessageIds: new Set<string>() } },
    );

    await waitFor(() => expect(result.current.prompts).toHaveLength(1));
    await act(async () => result.current.jumpToPrompt(1));
    expect(revealLoadedMessage).toHaveBeenCalledWith("older-prompt");
    expect(scrollToMessage).not.toHaveBeenCalled();

    rerender({ mountedHistoryMessageIds: new Set(["older-prompt"]) });
    await waitFor(() => expect(scrollToMessage).toHaveBeenCalledWith("older-prompt"));
  });

  it("reveals a fetched prompt that lands outside the mounted history window", async () => {
    runtime.listAgentTimelinePrompts.mockResolvedValue({
      epoch: "epoch-1",
      prompts: [{ seq: 1, timestamp: new Date(1).toISOString(), preview: "prompt" }],
    });
    const fetch = deferred<void>();
    runtime.fetchAgentTimeline.mockReturnValue(fetch.promise);
    const scrollToMessage = vi.fn();
    const revealLoadedMessage = vi.fn(() => true);
    const viewportRef = {
      current: {
        scrollToBottom: vi.fn(),
        prepareForViewportChange: vi.fn(),
        scrollToMessage,
      },
    };
    const fetchedPrompt = {
      id: "fetched-prompt",
      kind: "user_message" as const,
      text: "prompt",
      timestamp: new Date(1),
      timelineCursor: { epoch: "epoch-1", seq: 1 },
    };
    const { result, rerender } = renderHook(
      ({ tail, mountedHistoryMessageIds }) =>
        useChatOutline({
          agentId: "agent-1",
          serverId: "server-1",
          timelineEpoch: "epoch-1",
          tail,
          head: [],
          enabled: true,
          viewportRef,
          onJumpError: vi.fn(),
          mountedHistoryMessageIds,
          revealLoadedMessage,
        }),
      {
        initialProps: {
          tail: [] as (typeof fetchedPrompt)[],
          mountedHistoryMessageIds: new Set<string>(),
        },
      },
    );

    await waitFor(() => expect(result.current.prompts).toHaveLength(1));
    act(() => result.current.jumpToPrompt(1));
    await waitFor(() => expect(runtime.fetchAgentTimeline).toHaveBeenCalledOnce());

    rerender({ tail: [fetchedPrompt], mountedHistoryMessageIds: new Set<string>() });
    await waitFor(() => expect(revealLoadedMessage).toHaveBeenCalledWith(fetchedPrompt.id));
    expect(scrollToMessage).not.toHaveBeenCalled();

    rerender({ tail: [fetchedPrompt], mountedHistoryMessageIds: new Set([fetchedPrompt.id]) });
    await waitFor(() => expect(scrollToMessage).toHaveBeenCalledOnce());
    expect(scrollToMessage).toHaveBeenCalledWith(fetchedPrompt.id);
    await act(async () => fetch.resolve());
    expect(result.current.jumpError).toBe(false);
    expect(result.current.isJumping).toBe(false);
  });

  it("jumps directly to a loaded prompt in the live head", async () => {
    runtime.listAgentTimelinePrompts.mockResolvedValue({
      epoch: "epoch-1",
      prompts: [{ seq: 2, timestamp: new Date(2).toISOString(), preview: "prompt" }],
    });
    const scrollToMessage = vi.fn();
    const viewport: StreamViewportHandle = {
      scrollToBottom: vi.fn(),
      prepareForViewportChange: vi.fn(),
      scrollToMessage,
    };
    const livePrompt = {
      id: "live-prompt",
      kind: "user_message" as const,
      text: "prompt",
      timestamp: new Date(2),
      timelineCursor: { epoch: "epoch-1", seq: 2 },
    };
    const revealLoadedMessage = vi.fn();
    revealLoadedMessage.mockReturnValue(false);
    const { result } = renderHook(() =>
      useChatOutline({
        agentId: "agent-1",
        serverId: "server-1",
        timelineEpoch: "epoch-1",
        tail: [],
        head: [livePrompt],
        enabled: true,
        viewportRef: { current: viewport },
        onJumpError: vi.fn(),
        mountedHistoryMessageIds: new Set<string>(),
        revealLoadedMessage,
      }),
    );

    await waitFor(() => expect(result.current.prompts).toHaveLength(1));
    await act(async () => result.current.jumpToPrompt(2));
    expect(scrollToMessage).toHaveBeenCalledWith("live-prompt");
  });
});

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
function cancelledJumpFixture() {
  runtime.listAgentTimelinePrompts.mockReset().mockResolvedValue({
    epoch: "epoch-1",
    prompts: [{ seq: 1, timestamp: new Date(0).toISOString(), preview: "old" }],
  });
  const page = deferred<void>();
  runtime.fetchAgentTimeline.mockReset().mockReturnValue(page.promise);
  const scrollToMessage = vi.fn();
  const cancelMessageScroll = vi.fn();
  const onJumpError = vi.fn();
  const input = {
    agentId: "agent-1",
    serverId: "server-1",
    timelineEpoch: "epoch-1",
    enabled: true,
    head: [],
    viewportRef: {
      current: {
        scrollToBottom: vi.fn(),
        prepareForViewportChange: vi.fn(),
        scrollToMessage,
        cancelMessageScroll,
      },
    },
    onJumpError,
  };
  const hook = renderHook(({ tail }) => useChatOutline({ ...input, tail }), {
    initialProps: { tail: [stickyUser("latest", 3)] as StreamItem[] },
  });
  return { ...hook, page, scrollToMessage, cancelMessageScroll, onJumpError };
}

describe("prompt jump acceptance and cancellation", () => {
  it("does not scroll or report failure after cancelling a held older window", async () => {
    const fixture = cancelledJumpFixture();
    await waitFor(() => expect(fixture.result.current.indexReady).toBe(true));
    act(() => fixture.result.current.jumpToPrompt(1));
    const acceptance = runtime.fetchAgentTimeline.mock.calls.at(-1)![3] as { signal: AbortSignal };
    expect(acceptance.signal.aborted).toBe(false);
    act(() => fixture.result.current.cancelJump());
    expect(acceptance.signal.aborted).toBe(true);
    fixture.rerender({ tail: [stickyUser("old", 1), stickyUser("latest", 3)] });
    await act(async () => fixture.page.resolve());
    expect(fixture.scrollToMessage).not.toHaveBeenCalled();
    expect(fixture.result.current.isJumping).toBe(false);
    expect(fixture.result.current.jumpError).toBe(false);
    expect(fixture.onJumpError).not.toHaveBeenCalled();
  });

  it("suppresses a cancelled request's late failure", async () => {
    const fixture = cancelledJumpFixture();
    await waitFor(() => expect(fixture.result.current.indexReady).toBe(true));
    act(() => fixture.result.current.jumpToPrompt(1));
    act(() => fixture.result.current.cancelJump());
    await act(async () => fixture.page.reject(new Error("late failure")));
    expect(fixture.onJumpError).not.toHaveBeenCalled();
    expect(fixture.result.current.jumpError).toBe(false);
  });

  it("settles an unloaded successful jump without exposing a failure", async () => {
    const fixture = cancelledJumpFixture();
    await waitFor(() => expect(fixture.result.current.indexReady).toBe(true));
    act(() => fixture.result.current.jumpToPrompt(1));
    fixture.rerender({ tail: [stickyUser("old", 1), stickyUser("latest", 3)] });
    await act(async () => fixture.page.resolve());
    await waitFor(() => expect(fixture.result.current.isJumping).toBe(false));
    expect(fixture.scrollToMessage).toHaveBeenCalledWith("old");
    expect(fixture.scrollToMessage).toHaveBeenCalledTimes(1);
    expect(fixture.result.current.jumpError).toBe(false);
    expect(fixture.onJumpError).not.toHaveBeenCalled();
  });

  it("invalidates an already queued local-message animation frame", async () => {
    let frame: FrameRequestCallback | undefined;
    const cancelFrame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frame = callback;
      return 17;
    });
    vi.stubGlobal("cancelAnimationFrame", cancelFrame);
    try {
      const fixture = cancelledJumpFixture();
      const local = { ...stickyUser("local", 4), timelineCursor: undefined };
      fixture.rerender({ tail: [local] });
      act(() => fixture.result.current.jumpToMessage("local"));
      act(() => fixture.result.current.cancelJump());
      act(() => frame!(0));
      expect(cancelFrame).toHaveBeenCalledWith(17);
      expect(fixture.scrollToMessage).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

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

describe("viewport-owned sticky prompt", () => {
  it("hides while the original bubble intersects the viewport and follows manual reading", () => {
    const first = stickyUser("first", 1);
    const second = stickyUser("second", 3);
    const answer = {
      kind: "assistant_message" as const,
      text: "response",
      timestamp: new Date(2),
      id: "answer",
      timelineCursor: { epoch: "epoch-1", seq: 2 },
    };
    const reading = createPromptReadingPublisher();
    const input = { ...stickyInput([first, answer, second], stickyOutline([1, 3])), reading };
    const { result, rerender } = renderHook(useStickyPrompt, { initialProps: input });
    expect(result.current.message?.id).toBe("second");
    act(() => reading.publish(first.id, [first.id]));
    expect(result.current.message?.id).toBe("first");
    expect(result.current.stickyVisible).toBe(false);
    act(() =>
      reading.publish(first.id, [first.id], false, false, true, null, [
        { id: first.id, progress: 1 },
      ]),
    );
    expect(result.current.stickyVisible).toBe(true);
    expect(result.current.stickyProgress).toBe(1);
    act(() => reading.publish(first.id, [first.id]));
    expect(result.current.stickyVisible).toBe(false);
    act(() => reading.publish(answer.id));
    expect(result.current.stickyVisible).toBe(true);
    const incoming = stickyUser("third", 4);
    rerender({ ...input, items: [...input.items, incoming], outline: stickyOutline([1, 3, 4]) });
    expect(result.current.message?.id).toBe("first");
    act(() => reading.publish(second.id, [second.id]));
    expect(result.current.message?.id).toBe("second");
    expect(result.current.stickyVisible).toBe(false);
  });
  it("keeps an arrow target selected while smooth scrolling passes other prompts", () => {
    const users = [stickyUser("first", 1), stickyUser("second", 2), stickyUser("third", 3)];
    const reading = createPromptReadingPublisher();
    const input = { ...stickyInput(users, stickyOutline([1, 2, 3])), reading };
    const { result } = renderHook(useStickyPrompt, { initialProps: input });
    act(() => reading.publish(users[2]!.id, [users[2]!.id]));
    act(() => result.current.activate("third", -1));
    act(() => reading.publish("third", [], true));
    expect(result.current.message?.id).toBe("second");
    act(() => reading.publish("second", ["second"], false));
    expect(result.current.message?.id).toBe("second");
    expect(result.current.stickyVisible).toBe(false);
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
  act(() => reading.publish(olderAnswer.id));
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
  expect(result.current.stickyVisible).toBe(true);
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
  act(() => reading.publish(answer.id));
  await waitFor(() => expect(input.fetchPrompt).toHaveBeenCalledTimes(1));
  act(() => {
    result.current.followLatest();
    reading.publish(latest.id, [latest.id]);
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
  act(() => reading.publish("projected-markdown-block", [], false, false, true, 2));
  expect(result.current.message?.id).toBe("older");
  expect(result.current.stickyVisible).toBe(true);
  act(() => reading.publish("same-block", [], false, true, false, 2));
  expect(result.current.message?.id).toBe("latest");
});

it("does not transfer an arrow selection to a different reading-edge prompt after a clamped jump", () => {
  const users = [stickyUser("first", 1), stickyUser("second", 2), stickyUser("third", 3)];
  const reading = createPromptReadingPublisher();
  const input = { ...stickyInput(users, stickyOutline([1, 2, 3])), reading };
  const { result } = renderHook(useStickyPrompt, { initialProps: input });
  act(() => result.current.activate("third", -1));
  act(() => reading.publish("first", ["first", "second"], false, false, false, 1));
  expect(result.current.message?.id).toBe("second");
  expect(result.current.stickyVisible).toBe(false);
  act(() => reading.publish("first", ["first"], false, false, true, 1));
  expect(result.current.message?.id).toBe("first");
});

it("reads index-free context without applying an older viewed window", async () => {
  const answer = {
    kind: "assistant_message" as const,
    id: "answer",
    text: "response",
    timestamp: new Date(2),
    timelineCursor: { epoch: "epoch-1", seq: 2 },
  };
  const old = stickyUser("old", 1);
  const latest = stickyUser("latest", 3);
  const reading = createPromptReadingPublisher();
  const held = deferred<typeof old | undefined>();
  const fetchContext = vi.fn((_source: StreamItem, _signal: AbortSignal) => held.promise);
  const ownerPage = deferred<boolean>();
  const input = {
    ...stickyInput([answer, latest], stickyOutline([])),
    indexed: false,
    reading,
    fetchContext,
    loadOlder: vi.fn(() => ownerPage.promise),
  };
  const { result, rerender } = renderHook(useStickyPrompt, { initialProps: input });
  act(() => reading.publish(answer.id));
  expect(input.loadOlder).not.toHaveBeenCalled();
  await waitFor(() => expect(fetchContext).toHaveBeenCalledTimes(1));
  expect(input.loadOlder).not.toHaveBeenCalled();
  await act(async () => held.resolve(old));
  expect(result.current.message?.id).toBe("old");
  expect(result.current.stickyVisible).toBe(true);
  expect(input.outline.jumpToPrompt).not.toHaveBeenCalled();
  expect(reading.getSnapshot().rowId).toBe("answer");
  act(() => result.current.reveal());
  await waitFor(() => expect(input.loadOlder).toHaveBeenCalledTimes(1));
  expect(input.jumpToLoaded).not.toHaveBeenCalled();
  rerender({ ...input, items: [old, answer, latest], progressKey: "older" });
  await act(async () => ownerPage.resolve(true));
  await waitFor(() => expect(input.jumpToLoaded).toHaveBeenCalledWith("old", "original"));
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
  act(() => reading.publish("projected-old-response", [], false, false, true, 2));
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
  it("indexes only for a supported enabled consumer", () => {
    expect(shouldIndexUserPrompts(true, false, false)).toBe(false);
    expect(shouldIndexUserPrompts(true, true, false)).toBe(true);
    expect(shouldIndexUserPrompts(true, false, true)).toBe(true);
    expect(shouldIndexUserPrompts(false, true, true)).toBe(false);
  });
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
    expect(result.current.stickyVisible).toBe(false);
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
    const { result, rerender } = renderHook(useStickyPrompt, { initialProps: input });
    const acceptance = loadOlder.mock.calls[0]![0]!;
    rerender({ ...input, enabled: false });
    expect(acceptance.signal.aborted).toBe(true);
    expect(input.outline.cancelStickyJump).toHaveBeenCalledTimes(1);
    expect(input.outline.cancelJump).not.toHaveBeenCalled();
    await act(async () => page.resolve(true));
    expect(result.current.stickyVisible).toBe(false);
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
    reading.publish(answer.id, [], false, false, true, 2);
    const fetchPrompt = vi.fn(() => deferred<ReturnType<typeof stickyUser>>().promise);
    const input = {
      ...stickyInput([answer, user], stickyOutline([1, 3])),
      enabled: false,
      reading,
      fetchPrompt,
    };
    const { result } = renderHook(useStickyPrompt, { initialProps: input });
    expect(fetchPrompt).not.toHaveBeenCalled();
    expect(result.current.stickyVisible).toBe(false);
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
    reading.publish(answer.id, [], false, false, true, 2);
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
    expect(result.current.stickyVisible).toBe(false);
    expect(result.current.message).toBe(user);
    expect(result.current.message?.attachments).toBe(user.attachments);
    act(() => reading.publish(user.id, [user.id], false, true));
    rerender({ ...input, enabled: true });
    expect(result.current.message).toBe(user);
    expect(fetchPrompt).toHaveBeenCalledTimes(1);
  });
  it("cancels sticky window acceptance without cancelling an outline-owned jump", async () => {
    const fixture = cancelledJumpFixture();
    await waitFor(() => expect(fixture.result.current.indexReady).toBe(true));
    act(() => fixture.result.current.jumpToPrompt(1, { source: "sticky" }));
    const stickyAcceptance = runtime.fetchAgentTimeline.mock.calls.at(-1)![3] as {
      signal: AbortSignal;
    };
    act(() => fixture.result.current.cancelStickyJump!());
    expect(stickyAcceptance.signal.aborted).toBe(true);
    act(() => fixture.result.current.jumpToPrompt(1));
    const outlineAcceptance = runtime.fetchAgentTimeline.mock.calls.at(-1)![3] as {
      signal: AbortSignal;
    };
    act(() => fixture.result.current.cancelStickyJump!());
    expect(outlineAcceptance.signal.aborted).toBe(false);
    expect(fixture.result.current.isJumping).toBe(true);
    await act(async () => fixture.page.resolve());
  });
});

it("lets a newer original cover an older sticky copy before replacing it", () => {
  const first = stickyUser("first", 1);
  const second = stickyUser("second", 3);
  const reading = createPromptReadingPublisher();
  const input = { ...stickyInput([first, second], stickyOutline([1, 3])), reading };
  const { result } = renderHook(useStickyPrompt, { initialProps: input });
  act(() =>
    reading.publish(first.id, [second.id], false, false, true, 1, [
      { id: second.id, progress: 0, top: 60 },
    ]),
  );
  expect(result.current.message?.id).toBe(first.id);
  expect(result.current.occlusionTop).toBe(60);
  act(() =>
    reading.publish(first.id, [second.id], false, false, true, 1, [
      { id: second.id, progress: 0, top: 12 },
    ]),
  );
  expect(result.current.occlusionTop).toBe(12);
  act(() =>
    reading.publish(second.id, [second.id], false, false, true, 3, [
      { id: second.id, progress: 1, top: -24 },
    ]),
  );
  expect(result.current.message?.id).toBe(second.id);
  expect(result.current.occlusionTop).toBeUndefined();
});

it("preserves measured bubble placement through virtualization and invalidates it on resize", () => {
  const user = stickyUser("prompt", 1);
  const reading = createPromptReadingPublisher();
  const input = { ...stickyInput([user], stickyOutline([1])), reading };
  const { result } = renderHook(useStickyPrompt, { initialProps: input });
  act(() =>
    reading.publish(
      user.id,
      [user.id],
      false,
      false,
      true,
      1,
      [
        {
          id: user.id,
          progress: 1,
          top: 0,
          left: 180,
          width: 120,
          viewportWidth: 320,
          prefixHeightOne: 20,
          prefixHeightTwo: 20,
        },
      ],
      320,
    ),
  );
  expect(result.current.geometry).toMatchObject({ left: 180, width: 120, viewportWidth: 320 });
  act(() => reading.publish("answer", [], false, false, true, 2, [], 320));
  expect(result.current.geometry).toMatchObject({ left: 180, width: 120, viewportWidth: 320 });
  act(() => reading.publish("answer", [], false, false, true, 2, [], 480));
  expect(result.current.geometry).toBeUndefined();
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
    act(() => reading.publish(latest.id, [latest.id], false, false, false, 3));
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
    reading.publish(answer.id, [], false, false, true, 2);
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

  it("fences a held old-epoch read while fetching the same sequence in the new epoch", async () => {
    const old = deferred<ReturnType<typeof stickyUser>>();
    const fresh = deferred<ReturnType<typeof stickyUser>>();
    const fetchPrompt = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const input = {
      seq: 1,
      epoch: "epoch-1",
      knownPrompts: [] as ReturnType<typeof stickyUser>[],
      fetchPrompt,
    };
    const { result, rerender } = renderHook(useReadingPrompt, { initialProps: input });
    rerender({ ...input, epoch: "epoch-2" });
    expect(fetchPrompt).toHaveBeenCalledTimes(2);
    await act(async () => old.resolve(stickyUser("same", 1)));
    expect(result.current.item).toBeUndefined();
    expect(result.current.loading).toBe(true);
    const replacement = { ...stickyUser("same", 1, "epoch-2"), text: "Fresh content" };
    await act(async () => fresh.resolve(replacement));
    expect(result.current.item).toEqual(replacement);
    expect(result.current.error).toBe(false);
  });

  it("does not reuse resolved content when an epoch reuses the same prompt identity", async () => {
    const old = stickyUser("same", 1);
    const replacement = { ...stickyUser("same", 1, "epoch-2"), text: "Fresh content" };
    const fetchPrompt = vi.fn().mockResolvedValueOnce(old).mockResolvedValueOnce(replacement);
    const input = {
      seq: 1,
      epoch: "epoch-1",
      knownPrompts: [] as ReturnType<typeof stickyUser>[],
      fetchPrompt,
    };
    const { result, rerender } = renderHook(useReadingPrompt, { initialProps: input });
    await waitFor(() => expect(result.current.item).toEqual(old));
    rerender({ ...input, epoch: "epoch-2" });
    await waitFor(() => expect(result.current.item).toEqual(replacement));
    expect(fetchPrompt).toHaveBeenCalledTimes(2);
  });
});

/** Use the real advertised feature and canonical index to exercise the test gate's contract. */
function indexedReadLedger() {
  const ledger = createTimelineRequestLedger("agent", protocolSchemas);
  ledger.observe(
    { type: "status" },
    { status: "server_info", features: { agentTimelinePromptIndex: true } },
  );
  ledger.observe(
    { type: "agent.timeline.list_prompts.response" },
    {
      requestId: "index",
      agentId: "agent",
      epoch: "epoch",
      prompts: [1, 3].map((seq) => ({
        seq,
        timestamp: new Date(0).toISOString(),
        preview: `Prompt ${seq}`,
      })),
      error: null,
    },
  );
  return ledger;
}

function contentReadRequest(requestId = "content") {
  return {
    type: "fetch_agent_timeline_request",
    agentId: "agent",
    requestId,
    direction: "before",
    cursor: { epoch: "epoch", seq: 2 },
    limit: 1,
    projection: "projected",
  };
}

function contentReadResponse(type = "user_message") {
  return {
    requestId: "content",
    agentId: "agent",
    agent: null,
    direction: "before",
    epoch: "epoch",
    projection: "projected",
    reset: false,
    staleCursor: false,
    gap: false,
    window: { minSeq: 1, maxSeq: 3, nextSeq: 4 },
    hasOlder: false,
    hasNewer: true,
    startCursor: { epoch: "epoch", seq: 1 },
    endCursor: { epoch: "epoch", seq: 1 },
    entries: [
      {
        provider: "mock",
        timestamp: new Date(0).toISOString(),
        seqStart: 1,
        seqEnd: 1,
        sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }],
        collapsed: [],
        item: { type, text: "Prompt 1", messageId: "prompt-1" },
      },
    ],
    error: null,
  };
}

describe("explicit history-window and indexed-content accounting", () => {
  it("accounts for every request without consuming a held window slot for canonical content", () => {
    const ledger = indexedReadLedger();
    expect(ledger.classify({ ...contentReadRequest("window"), limit: 40 })).toBe("window");
    expect(ledger.classify(contentReadRequest())).toBe("content");
    expect(
      ledger.beforeResponsePurpose({ requestId: "window", agentId: "agent", direction: "before" }),
    ).toBe("window");
    expect(
      ledger.beforeResponsePurpose({ requestId: "content", agentId: "agent", direction: "before" }),
    ).toBe("content");
    ledger.completeContent(contentReadResponse());
    expect(ledger.summary()).toEqual({
      allBefore: 2,
      windowBefore: 1,
      contentBefore: 1,
      pendingContent: 0,
      errors: [],
    });
  });

  it("rejects cache-shaped reads without an advertised capability and canonical index", () => {
    const ledger = createTimelineRequestLedger("agent", protocolSchemas);
    expect(ledger.classify(contentReadRequest())).toBeUndefined();
    expect(ledger.summary().allBefore).toBe(1);
    expect(ledger.summary().errors).toHaveLength(1);
  });

  it.each([
    { limit: 2 },
    { projection: "canonical" },
    { mergeWindow: true },
    { cursor: { epoch: "epoch", seq: 3 } },
    { cursor: { epoch: "stale", seq: 2 } },
  ])("rejects unclassified before request %j instead of silently filtering it", (invalid) => {
    const ledger = indexedReadLedger();
    expect(ledger.classify({ ...contentReadRequest(), ...invalid })).toBeUndefined();
    expect(ledger.summary()).toMatchObject({ allBefore: 1, windowBefore: 0, contentBefore: 0 });
    expect(ledger.summary().errors).toHaveLength(1);
  });

  it("rejects a second read of the same indexed prompt in the same epoch", () => {
    const ledger = indexedReadLedger();
    expect(ledger.classify(contentReadRequest())).toBe("content");
    ledger.completeContent(contentReadResponse());
    expect(ledger.classify(contentReadRequest("duplicate"))).toBeUndefined();
    expect(ledger.summary()).toMatchObject({ allBefore: 2, windowBefore: 0, contentBefore: 1 });
    expect(ledger.summary().errors).toHaveLength(1);
  });

  it("rejects content already present in delivered authoritative pages", () => {
    const ledger = indexedReadLedger();
    ledger.observeWindow(contentReadResponse());
    expect(ledger.classify(contentReadRequest())).toBeUndefined();
    expect(ledger.summary().errors).toHaveLength(1);
  });

  it("rejects a non-user content response and an unclassified response identity", () => {
    const ledger = indexedReadLedger();
    expect(ledger.classify(contentReadRequest())).toBe("content");
    ledger.completeContent(contentReadResponse("assistant_message"));
    expect(
      ledger.beforeResponsePurpose({ requestId: "unknown", agentId: "agent", direction: "before" }),
    ).toBeUndefined();
    expect(ledger.summary().errors).toHaveLength(2);
  });
});

it.each([null, {}, { seqStart: 1, seqEnd: 1 }, { seqStart: 1, seqEnd: 1, item: null }])(
  "records malformed cache entry %j instead of escaping the socket callback",
  (entry) => {
    const ledger = indexedReadLedger();
    ledger.classify(contentReadRequest());
    expect(() =>
      ledger.completeContent({ ...contentReadResponse(), entries: [entry] }),
    ).not.toThrow();
    expect(ledger.summary()).toMatchObject({
      pendingContent: 0,
      errors: ["Malformed canonical prompt-content response"],
    });
  },
);

it.each([
  { agentId: "other" },
  { direction: "after" },
  { startCursor: { epoch: "other", seq: 1 } },
  { endCursor: { epoch: "epoch", seq: 2 } },
  { entries: [] },
])("rejects invalid canonical content identity %j", (invalid) => {
  const ledger = indexedReadLedger();
  ledger.classify(contentReadRequest());
  ledger.completeContent({ ...contentReadResponse(), ...invalid });
  expect(ledger.summary().errors).toHaveLength(1);
});

it("rejects a malformed canonical index before trusting its sequence identity", () => {
  const ledger = indexedReadLedger();
  ledger.observe(
    { type: "agent.timeline.list_prompts.response" },
    { requestId: "broken", agentId: "agent", epoch: "epoch", prompts: [null], error: null },
  );
  expect(ledger.classify(contentReadRequest())).toBeUndefined();
  expect(ledger.summary().errors).toHaveLength(2);
});

describe("passive indexed latest prompt content", () => {
  it("keeps assistant-only history and following intact, then loads and scrolls only for explicit review", async () => {
    runtime.listAgentTimelinePrompts.mockReset().mockResolvedValue({
      epoch: "epoch-1",
      prompts: [{ seq: 1, timestamp: new Date(0).toISOString(), preview: "Latest prompt" }],
    });
    const window = deferred<void>();
    runtime.fetchAgentTimeline.mockReset().mockReturnValue(window.promise);
    const content = deferred<ReturnType<typeof stickyUser>>();
    const fetchPrompt = vi.fn(() => content.promise);
    const assistant: StreamItem = {
      kind: "assistant_message",
      id: "tail-answer",
      text: "Current tail",
      timestamp: new Date(0),
      timelineCursor: { epoch: "epoch-1", seq: 206 },
    };
    const reading = createPromptReadingPublisher();
    reading.publish(assistant.id, [], false, true, false, 206);
    const before = reading.getSnapshot();
    const scrollToMessage = vi.fn();
    const viewportRef = {
      current: {
        scrollToBottom: vi.fn(),
        prepareForViewportChange: vi.fn(),
        scrollToMessage,
        cancelMessageScroll: vi.fn(),
      },
    };
    const loadOlder = vi.fn(async () => false);
    const jumpToLoaded = vi.fn();
    const tail: StreamItem[] = [assistant];
    const { result, rerender } = renderHook(
      ({ items }) => {
        const outline = useChatOutline({
          agentId: "agent",
          serverId: "server",
          timelineEpoch: "epoch-1",
          enabled: true,
          tail: items,
          head: [],
          viewportRef,
          onJumpError: vi.fn(),
        });
        const sticky = useStickyPrompt({
          ...stickyInput(items, outline),
          reading,
          fetchPrompt,
          loadOlder,
          jumpToLoaded,
        });
        return { outline, sticky };
      },
      { initialProps: { items: tail } },
    );
    await waitFor(() => expect(result.current.outline.indexReady).toBe(true));
    expect(runtime.fetchAgentTimeline).not.toHaveBeenCalled();
    await waitFor(() => expect(fetchPrompt).toHaveBeenCalledTimes(1));
    expect(loadOlder).not.toHaveBeenCalled();
    expect(scrollToMessage).not.toHaveBeenCalled();
    const prompt = {
      ...stickyUser("latest", 1),
      text: "Latest prompt\n  formatting retained",
      images: [{ id: "image" }],
      attachments: [{ id: "file" }],
    } as ReturnType<typeof stickyUser>;
    await act(async () => content.resolve(prompt));
    expect(result.current.sticky.message).toEqual(prompt);
    expect(reading.getSnapshot()).toBe(before);
    expect(tail).toEqual([assistant]);
    expect(runtime.fetchAgentTimeline).not.toHaveBeenCalled();
    act(() => result.current.sticky.reveal());
    expect(runtime.fetchAgentTimeline).toHaveBeenCalledTimes(1);
    expect(runtime.fetchAgentTimeline).toHaveBeenCalledWith(
      "server",
      "agent",
      {
        direction: "before",
        cursor: { epoch: "epoch-1", seq: 22 },
        limit: 40,
        projection: "projected",
        mergeWindow: true,
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(scrollToMessage).not.toHaveBeenCalled();
    expect(jumpToLoaded).not.toHaveBeenCalled();
    expect(result.current.sticky.message).toEqual(prompt);
    rerender({ items: [prompt, assistant] });
    await waitFor(() => expect(scrollToMessage).toHaveBeenCalledWith("latest"));
    await act(async () => window.resolve());
    expect(scrollToMessage).toHaveBeenCalledTimes(1);
    expect(result.current.sticky.busy).toBe(false);
    expect(result.current.sticky.error).toBe(false);
    expect(reading.getSnapshot()).toBe(before);
  });
});

// Ranges and shared message identity are captured from the old-host response.
// Predecessor USER and intervening pages below are synthetic boundary fixtures.
describe("index-free cache-only context", () => {
  const source: StreamItem = {
    kind: "assistant_message",
    id: "segment-256",
    messageId: "same",
    text: "answer",
    timestamp: new Date(0),
    timelineCursor: { epoch: "epoch", seq: 256 },
  };
  const entry = (start: number, end: number, type = "assistant_message"): ContextEntry => ({
    provider: "mock",
    timestamp: new Date(0).toISOString(),
    seqStart: start,
    seqEnd: end,
    sourceSeqRanges: [{ startSeq: start, endSeq: end }],
    collapsed: [],
    item:
      type === "user_message"
        ? { type: "user_message", text: "original prompt" }
        : { type: "assistant_message", messageId: "same", text: "answer" },
  });
  const page = (entries: ContextEntry[], hasOlder = true): ContextPage => ({
    epoch: "epoch",
    entries,
    hasOlder,
    error: null,
    reset: false,
    staleCursor: false,
    gap: false,
  });

  it("separates shared messageId occurrences and walks true expanded source starts", async () => {
    const reader = vi
      .fn()
      .mockResolvedValueOnce(page([entry(246, 256)]))
      .mockResolvedValueOnce(page([entry(220, 242)]))
      .mockResolvedValueOnce(page([entry(212, 217)]))
      .mockResolvedValueOnce(page([entry(63, 63, "user_message"), entry(64, 64, "user_message")]));
    const prompt = await fetchReadingPromptContext(reader, source, new AbortController().signal);
    expect(prompt?.timelineCursor).toEqual({ epoch: "epoch", seq: 64 });
    expect(prompt?.text).toBe("original prompt");
    expect(
      reader.mock.calls.map(([request]) => [request.cursor, request.limit, request.projection]),
    ).toEqual([
      [257, 1, "projected"],
      [246, 40, "canonical"],
      [220, 40, "canonical"],
      [212, 40, "canonical"],
    ]);
  });

  it("coalesces an advancing canonical assistant occurrence into one bounded discovery", async () => {
    const owner = createCanonicalPromptContexts();
    const held = deferred<ContextPage>();
    const reader = vi
      .fn()
      .mockImplementationOnce(() => held.promise)
      .mockResolvedValueOnce(page([entry(64, 64, "user_message")], false));
    const input = {
      owner,
      agentId: "agent",
      epoch: "epoch",
      source,
      ordinaryItems: [source],
      coverage: [{ epoch: "epoch", startSeq: 246, endSeq: 256 }],
      enabled: true,
      lookup: { agentId: "agent", readPage: reader, projection: "canonical" as const },
    };
    const { result, rerender, unmount } = renderHook(useCanonicalPromptContext, {
      initialProps: input,
    });
    await waitFor(() => expect(reader).toHaveBeenCalledTimes(1));
    let current = source;
    for (let seq = 257; seq <= 270; seq += 1) {
      current = {
        ...source,
        text: `answer${"x".repeat(seq - 256)}`,
        timestamp: new Date(seq),
        timelineCursor: { epoch: "epoch", seq },
      };
      rerender({
        ...input,
        source: current,
        ordinaryItems: [current],
        coverage: [{ epoch: "epoch", startSeq: 246, endSeq: seq }],
      });
    }
    expect(reader.mock.calls[0]![1]?.aborted).toBe(false);
    await act(async () => held.resolve(page([entry(246, 270)])));
    await waitFor(() => expect(result.current.contexts[0]?.prompt.timelineCursor?.seq).toBe(64));
    for (let seq = 271; seq <= 280; seq += 1) {
      current = {
        ...source,
        text: `answer${"x".repeat(seq - 256)}`,
        timestamp: new Date(seq),
        timelineCursor: { epoch: "epoch", seq },
      };
      rerender({
        ...input,
        source: current,
        ordinaryItems: [current],
        coverage: [{ epoch: "epoch", startSeq: 246, endSeq: seq }],
      });
    }
    expect(reader).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBe(false);
    unmount();
    owner.dispose();
  });

  it("continues a bounded canonical predecessor read only on explicit retry", async () => {
    let end = 246;
    let calls = 0;
    const reader = vi.fn(
      async (
        request: Parameters<import("../fetch-reading-prompt-context").ContextPageReader>[0],
      ) => {
        calls += 1;
        if (request.limit === 1) return page([entry(246, 256)]);
        if (calls === 9) return page([entry(64, 64, "user_message")], false);
        return page([entry(--end, end)]);
      },
    );
    const owner = createCanonicalPromptContexts();
    const channel = {};
    await expect(
      owner.request({
        agentId: "agent",
        source,
        channel,
        signal: new AbortController().signal,
        lookup: { agentId: "agent", readPage: reader, projection: "canonical" },
        lookupAllowed: true,
        retryToken: 0,
      }),
    ).rejects.toThrow("request budget");
    expect(reader).toHaveBeenCalledTimes(8);
    expect(owner.read("agent", "epoch")).toEqual([]);
    const prompt = await owner.request({
      agentId: "agent",
      source,
      channel,
      signal: new AbortController().signal,
      lookup: { agentId: "agent", readPage: reader, projection: "canonical" },
      lookupAllowed: true,
      retryToken: 1,
    });
    expect(prompt?.timelineCursor).toEqual({ epoch: "epoch", seq: 64 });
    expect(reader).toHaveBeenCalledTimes(9);
    expect(reader.mock.calls[8]![0]).toEqual({
      epoch: "epoch",
      cursor: 239,
      limit: 40,
      projection: "canonical",
    });
    expect(owner.snapshot("agent")?.ranges).toEqual([{ startSeq: 64, endSeq: 64 }]);
    owner.dispose();
  });

  it("counts the source probe inside the eight-read cap", async () => {
    let end = 246;
    const reader = vi
      .fn()
      .mockImplementation(async (request) =>
        request.limit === 1 ? page([entry(246, 256)]) : page([entry(--end, end)]),
      );
    await expect(
      fetchReadingPromptContext(reader, source, new AbortController().signal),
    ).rejects.toThrow("request budget");
    expect(reader).toHaveBeenCalledTimes(8);
  });

  it.each([
    { epoch: "wrong" },
    { reset: true },
    { staleCursor: true },
    { gap: true },
    { error: "failed" },
    { entries: [entry(220, 242)] },
    { entries: [entry(246, 256), entry(246, 256)] },
    { entries: [{ ...entry(246, 256), sourceSeqRanges: [] }] },
  ])("rejects changed, missing or ambiguous source metadata %j", async (invalid) => {
    const reader = vi.fn().mockResolvedValue({ ...page([entry(246, 256)]), ...invalid });
    await expect(
      fetchReadingPromptContext(reader, source, new AbortController().signal),
    ).rejects.toThrow();
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it("exhausts tool-only history without applying pages", async () => {
    const reader = vi
      .fn()
      .mockResolvedValueOnce(page([entry(246, 256)]))
      .mockResolvedValueOnce(page([], false));
    expect(
      await fetchReadingPromptContext(reader, source, new AbortController().signal),
    ).toBeUndefined();
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it("rejects nonprogress instead of looping", async () => {
    const reader = vi
      .fn()
      .mockResolvedValueOnce(page([entry(246, 256)]))
      .mockResolvedValueOnce(page([entry(246, 256)]));
    await expect(
      fetchReadingPromptContext(reader, source, new AbortController().signal),
    ).rejects.toThrow("backward");
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it("cancels a held probe before any backward request", async () => {
    const held = deferred<ContextPage>();
    const reader = vi.fn(() => held.promise);
    const controller = new AbortController();
    const result = fetchReadingPromptContext(reader, source, controller.signal);
    controller.abort();
    held.resolve(page([entry(246, 256)]));
    await expect(result).rejects.toThrow();
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it("walks tool-only pages to the nearest USER and cancels held backward work", async () => {
    const tool: ContextEntry = {
      ...entry(218, 218),
      item: {
        type: "tool_call",
        callId: "call",
        name: "Read",
        status: "completed",
        error: null,
        detail: { type: "read", filePath: "file" },
      },
    };
    const held = deferred<ContextPage>();
    const reader = vi
      .fn()
      .mockResolvedValueOnce(page([entry(246, 256)]))
      .mockResolvedValueOnce(page([tool]))
      .mockImplementationOnce(() => held.promise);
    const controller = new AbortController();
    const result = fetchReadingPromptContext(reader, source, controller.signal);
    await waitFor(() => expect(reader).toHaveBeenCalledTimes(3));
    expect(reader.mock.calls[2]![0].cursor).toBe(218);
    controller.abort();
    held.resolve(page([entry(63, 63, "user_message")]));
    await expect(result).rejects.toThrow("cancelled");
    expect(reader).toHaveBeenCalledTimes(3);
  });

  it("retries a context failure and caches exhausted history without repeated reads", async () => {
    const fetchContext = vi
      .fn()
      .mockRejectedValueOnce(new Error("missing source"))
      .mockResolvedValue(undefined);
    const { result, rerender } = renderHook(useReadingPrompt, {
      initialProps: { epoch: "epoch", seq: undefined, knownPrompts: [], source, fetchContext },
    });
    await waitFor(() => expect(result.current.error).toBe(true));
    act(() => result.current.retry());
    await waitFor(() => expect(fetchContext).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.loading).toBe(false));
    rerender({
      epoch: "epoch",
      seq: undefined,
      knownPrompts: [],
      source: { ...source },
      fetchContext,
    });
    expect(result.current.error).toBe(false);
    expect(fetchContext).toHaveBeenCalledTimes(2);
  });

  it("shares the sixteen-entry cap between context and known canonical prompts", async () => {
    const fetchContext = vi.fn(async () => stickyUser("context", 1, "epoch"));
    const knownPrompts = Array.from({ length: 16 }, (_, i) =>
      stickyUser(`known-${i}`, i + 300, "epoch"),
    );
    const { result, rerender } = renderHook(useReadingPrompt, {
      initialProps: {
        epoch: "epoch",
        seq: undefined,
        knownPrompts: [] as UserPrompt[],
        source,
        fetchContext,
      },
    });
    await waitFor(() => expect(result.current.item?.id).toBe("context"));
    rerender({
      epoch: "epoch",
      seq: undefined,
      knownPrompts,
      source: { ...source, id: "other" },
      fetchContext,
    });
    await waitFor(() => expect(fetchContext).toHaveBeenCalledTimes(2));
    rerender({ epoch: "epoch", seq: undefined, knownPrompts, source, fetchContext });
    await waitFor(() => expect(fetchContext).toHaveBeenCalledTimes(3));
  });

  it("scopes child reads to the exact owner and never applies their payload", async () => {
    const fetchProviderSubagentTimeline = vi.fn().mockResolvedValue({
      ...page([entry(246, 256)]),
      parentAgentId: "parent",
      subagentId: "child",
      provider: "mock",
      direction: "before",
      rows: [{ ...entry(246, 256), seq: 256 }],
    });
    const client = { fetchProviderSubagentTimeline } as unknown as DaemonClient;
    const reader = childContextPageReader(client, "parent", "child");
    const request = { epoch: "epoch", cursor: 257, limit: 1, projection: "projected" as const };
    expect((await reader(request)).entries[0]?.seqStart).toBe(246);
    expect(fetchProviderSubagentTimeline).toHaveBeenCalledExactlyOnceWith("parent", "child", {
      direction: "before",
      cursor: { epoch: "epoch", seq: 257 },
      limit: 1,
    });
    fetchProviderSubagentTimeline.mockResolvedValue({
      parentAgentId: "other",
      subagentId: "child",
    });
    await expect(reader(request)).rejects.toThrow("child identity");
  });

  it("does not publish a held context after epoch replacement", async () => {
    const held = deferred<UserPrompt | undefined>();
    const fetchContext = vi.fn((_source: StreamItem, _signal: AbortSignal) => held.promise);
    const { result, rerender } = renderHook(useReadingPrompt, {
      initialProps: { epoch: "epoch", seq: undefined, knownPrompts: [], source, fetchContext },
    });
    await waitFor(() => expect(fetchContext).toHaveBeenCalledTimes(1));
    rerender({
      epoch: "new",
      seq: undefined,
      knownPrompts: [],
      source: { ...source, timelineCursor: { epoch: "new", seq: 256 } },
      fetchContext,
    });
    expect(fetchContext.mock.calls[0]![1].aborted).toBe(true);
    await act(async () => held.resolve(stickyUser("old", 1, "epoch")));
    expect(result.current.item?.timelineCursor?.epoch).not.toBe("epoch");
  });
});

describe("normal context reader response projection contract", () => {
  const request = { epoch: "epoch", cursor: 2, limit: 40, projection: "canonical" as const };

  it.each(["projected", "canonical"])(
    "accepts the supported %s response to a canonical request",
    async (projection) => {
      const page = { ...contentReadResponse(), projection };
      const fetchAgentTimeline = vi.fn().mockResolvedValue(page);
      const client = { fetchAgentTimeline } as unknown as DaemonClient;
      await expect(normalContextPageReader(client, "agent")(request)).resolves.toBe(page);
      expect(fetchAgentTimeline).toHaveBeenCalledWith("agent", {
        direction: "before",
        cursor: { epoch: "epoch", seq: 2 },
        limit: 40,
        projection: "canonical",
      });
    },
  );

  it("requires projected responses for projected source probes", async () => {
    const fetchAgentTimeline = vi
      .fn()
      .mockResolvedValue({ ...contentReadResponse(), projection: "canonical" });
    const client = { fetchAgentTimeline } as unknown as DaemonClient;
    await expect(
      normalContextPageReader(client, "agent")({ ...request, projection: "projected" }),
    ).rejects.toThrow("different journal identity");
  });

  it.each([
    { agentId: "other" },
    { direction: "tail" },
    { projection: "unknown" },
    { projection: undefined },
  ])("rejects a different response journal %j", async (change) => {
    const fetchAgentTimeline = vi.fn().mockResolvedValue({ ...contentReadResponse(), ...change });
    const client = { fetchAgentTimeline } as unknown as DaemonClient;
    await expect(normalContextPageReader(client, "agent")(request)).rejects.toThrow(
      "different journal identity",
    );
  });
});

describe("strict source context accounting", () => {
  const sourceResponse = () => ({
    ...contentReadResponse("assistant_message"),
    direction: "tail",
    hasOlder: true,
    entries: [
      {
        ...contentReadResponse("assistant_message").entries[0]!,
        seqStart: 246,
        seqEnd: 256,
        sourceSeqRanges: [{ startSeq: 246, endSeq: 256 }],
      },
    ],
  });
  const probeRequest = () => ({
    ...contentReadRequest("probe"),
    cursor: { epoch: "epoch", seq: 257 },
  });
  const probeResponse = () => ({
    ...sourceResponse(),
    direction: "before",
    requestId: "probe",
    startCursor: { epoch: "epoch", seq: 256 },
    endCursor: { epoch: "epoch", seq: 256 },
  });
  const contextRequest = () => ({
    ...contentReadRequest("context-page"),
    limit: 40,
    projection: "canonical",
    cursor: { epoch: "epoch", seq: 246 },
  });
  const oldLedger = () => {
    const ledger = createTimelineRequestLedger("agent", protocolSchemas);
    ledger.observeWindow(sourceResponse());
    return ledger;
  };
  /** Register a second source while preserving the first chain's outstanding wire reads. */
  const addOverlappingSource = (ledger: ReturnType<typeof oldLedger>, start = 146, end = 156) => {
    const source = sourceResponse();
    source.entries[0]!.seqStart = start;
    source.entries[0]!.seqEnd = end;
    source.entries[0]!.sourceSeqRanges = [{ startSeq: start, endSeq: end }];
    ledger.observeWindow(source);
    expect(
      ledger.classify({
        ...probeRequest(),
        requestId: "next-probe",
        cursor: { epoch: "epoch", seq: end + 1 },
      }),
    ).toBe("context");
    return {
      ...source,
      direction: "before",
      requestId: "next-probe",
      startCursor: { epoch: "epoch", seq: end },
      endCursor: { epoch: "epoch", seq: end },
    };
  };

  it.each([true, false])(
    "isolates overlapping chains and mounting ownership (older response first: %s)",
    (olderFirst) => {
      const ledger = oldLedger();
      ledger.classify(probeRequest());
      const nextProbe = addOverlappingSource(ledger);
      for (const response of olderFirst
        ? [probeResponse(), nextProbe]
        : [nextProbe, probeResponse()]) {
        ledger.completeContext(response);
      }
      expect(ledger.classify(contextRequest())).toBe("context");
      expect(
        ledger.classify({
          ...contextRequest(),
          requestId: "next-context",
          cursor: { epoch: "epoch", seq: 146 },
        }),
      ).toBe("context");
      const older = { ...contentReadResponse(), requestId: "context-page" };
      const newer = { ...contentReadResponse(), requestId: "next-context" };
      newer.entries[0]!.item = {
        type: "user_message",
        text: "Prompt 2",
        messageId: "prompt-2",
      };
      for (const response of olderFirst ? [older, newer] : [newer, older]) {
        ledger.completeContext(response);
        expect(ledger.mountingPrompt()).toEqual(
          response === older && olderFirst ? null : { id: "prompt-2", text: "Prompt 2" },
        );
      }
      expect(ledger.certifiedPrompts()).toHaveLength(2);
      expect(ledger.summary()).toMatchObject({
        contextBefore: 4,
        pendingContext: 0,
        contextChainActive: false,
        windowBefore: 0,
        errors: [],
      });
    },
  );

  it("rejects a canonical child shared by two eligible source chains", () => {
    const ledger = oldLedger();
    ledger.classify(probeRequest());
    const nextProbe = addOverlappingSource(ledger, 246, 356);
    ledger.completeContext(probeResponse());
    ledger.completeContext(nextProbe);
    expect(ledger.classify(contextRequest())).toBeUndefined();
    expect(ledger.summary().errors).toHaveLength(1);
  });

  it("keeps the eight-read limit independent for overlapping chains", () => {
    const ledger = oldLedger();
    ledger.classify(probeRequest());
    const nextProbe = addOverlappingSource(ledger);
    ledger.completeContext(probeResponse());
    ledger.completeContext(nextProbe);
    for (const [prefix, start] of [
      ["older", 246],
      ["newer", 146],
    ] as const) {
      for (let n = 0; n < 7; n += 1) {
        const cursor = start - n;
        const requestId = `${prefix}-${n}`;
        expect(
          ledger.classify({
            ...contextRequest(),
            requestId,
            cursor: { epoch: "epoch", seq: cursor },
          }),
        ).toBe("context");
        const seq = cursor - 1;
        ledger.completeContext({
          ...sourceResponse(),
          direction: "before",
          requestId,
          startCursor: { epoch: "epoch", seq },
          endCursor: { epoch: "epoch", seq },
          entries: [
            {
              ...sourceResponse().entries[0]!,
              seqStart: seq,
              seqEnd: seq,
              sourceSeqRanges: [{ startSeq: seq, endSeq: seq }],
            },
          ],
        });
      }
      expect(
        ledger.classify({
          ...contextRequest(),
          requestId: `${prefix}-ninth`,
          cursor: { epoch: "epoch", seq: start - 7 },
        }),
      ).toBeUndefined();
    }
    expect(ledger.summary()).toMatchObject({
      contextBefore: 16,
      pendingContext: 0,
      windowBefore: 0,
    });
    expect(ledger.summary().errors).toHaveLength(2);
  });

  it.each([
    { indexed: false, projection: "projected" },
    { indexed: true, projection: "projected" },
    { indexed: false, projection: "canonical" },
    { indexed: true, projection: "canonical" },
  ])(
    "accounts for source context without changing the window budget (indexed: $indexed, projection: $projection)",
    ({ indexed, projection }) => {
      const ledger = indexed ? indexedReadLedger() : oldLedger();
      if (indexed) ledger.observeWindow(sourceResponse());
      expect(ledger.classify({ ...contentReadRequest("window"), limit: 40 })).toBe("window");
      expect(ledger.classify(probeRequest())).toBe("context");
      ledger.completeContext(probeResponse());
      expect(ledger.classify(contextRequest())).toBe("context");
      ledger.completeContext({
        ...contentReadResponse(),
        requestId: "context-page",
        projection,
      });
      expect(ledger.certifiedPrompts()).toEqual([{ id: "prompt-1", text: "Prompt 1" }]);
      expect(ledger.summary()).toMatchObject({
        allBefore: 3,
        windowBefore: 1,
        contentBefore: 0,
        contextBefore: 2,
        pendingContext: 0,
        contextChainActive: false,
        errors: [],
      });
    },
  );
  it("replaces mounting demand per source while adopted prompts return to ordinary accounting", () => {
    const ledger = oldLedger();
    ledger.classify(probeRequest());
    ledger.completeContext(probeResponse());
    ledger.classify(contextRequest());
    const first = { ...contentReadResponse(), requestId: "context-page" };
    ledger.completeContext(first);
    expect(ledger.mountingPrompt()).toEqual({ id: "prompt-1", text: "Prompt 1" });
    expect(ledger.certifiedPrompts()).toHaveLength(1);
    ledger.observeWindow(first);
    expect(ledger.certifiedPrompts()).toEqual([]);

    const nextSource = sourceResponse();
    nextSource.entries[0]!.seqStart = 146;
    nextSource.entries[0]!.seqEnd = 156;
    nextSource.entries[0]!.sourceSeqRanges = [{ startSeq: 146, endSeq: 156 }];
    ledger.observeWindow(nextSource);
    ledger.classify({
      ...probeRequest(),
      requestId: "next-probe",
      cursor: { epoch: "epoch", seq: 157 },
    });
    ledger.completeContext({
      ...nextSource,
      direction: "before",
      requestId: "next-probe",
      startCursor: { epoch: "epoch", seq: 156 },
      endCursor: { epoch: "epoch", seq: 156 },
    });
    expect(ledger.mountingPrompt()).toBeNull();
    // A late completion of the previous source cannot restore its mounting obligation.
    ledger.completeContext(first);
    expect(ledger.mountingPrompt()).toBeNull();
    expect(ledger.summary().errors).toEqual(["Malformed or repeated context response"]);
    ledger.classify({
      ...contextRequest(),
      requestId: "next-context",
      cursor: { epoch: "epoch", seq: 146 },
    });
    const next = contentReadResponse();
    next.entries[0]!.item = { type: "user_message", text: "Prompt 2", messageId: "prompt-2" };
    ledger.completeContext({ ...next, requestId: "next-context" });
    expect(ledger.mountingPrompt()).toEqual({ id: "prompt-2", text: "Prompt 2" });
    expect(ledger.certifiedPrompts()).toEqual([{ id: "prompt-2", text: "Prompt 2" }]);
  });

  it.each([
    { agentId: "other" },
    { limit: 2 },
    { mergeWindow: true },
    { cursor: { epoch: "other", seq: 257 } },
    { cursor: { epoch: "epoch", seq: 256 } },
  ])("rejects unowned probe %j", (invalid) => {
    const ledger = oldLedger();
    expect(ledger.classify({ ...probeRequest(), ...invalid })).toBeUndefined();
    expect(ledger.summary().errors).toHaveLength(1);
  });
  it.each([
    { epoch: "other" },
    { agentId: "other" },
    { entries: [{}] },
    { reset: true },
    { endCursor: { epoch: "epoch", seq: 255 } },
    { entries: [{ ...sourceResponse().entries[0]!, sourceSeqRanges: [] }] },
    { entries: [{ ...sourceResponse().entries[0]!, seqEnd: 255 }] },
  ])("records malformed or changed probe response %j without throwing", (invalid) => {
    const ledger = oldLedger();
    ledger.classify(probeRequest());
    expect(() => ledger.completeContext({ ...probeResponse(), ...invalid })).not.toThrow();
    expect(ledger.summary().errors).toHaveLength(1);
  });
  it("rejects duplicate probe, response and wrong backward cursor", () => {
    const ledger = oldLedger();
    ledger.classify(probeRequest());
    ledger.completeContext(probeResponse());
    expect(ledger.classify({ ...probeRequest(), requestId: "duplicate" })).toBeUndefined();
    ledger.completeContext(probeResponse());
    expect(
      ledger.classify({ ...contextRequest(), cursor: { epoch: "epoch", seq: 247 } }),
    ).toBeUndefined();
    expect(ledger.summary().errors).toHaveLength(3);
  });
  it("rejects a ninth request rather than assigning it a window slot", () => {
    const ledger = oldLedger();
    ledger.classify(probeRequest());
    ledger.completeContext(probeResponse());
    for (let n = 1; n < 8; n += 1) {
      const cursor = 247 - n;
      const id = `page-${n}`;
      expect(
        ledger.classify({
          ...contextRequest(),
          requestId: id,
          cursor: { epoch: "epoch", seq: cursor },
        }),
      ).toBe("context");
      const seq = cursor - 1;
      ledger.completeContext({
        ...sourceResponse(),
        direction: "before",
        projection: "projected",
        requestId: id,
        startCursor: { epoch: "epoch", seq },
        endCursor: { epoch: "epoch", seq },
        entries: [
          {
            ...sourceResponse().entries[0]!,
            seqStart: seq,
            seqEnd: seq,
            sourceSeqRanges: [{ startSeq: seq, endSeq: seq }],
          },
        ],
      });
    }
    expect(
      ledger.classify({
        ...contextRequest(),
        requestId: "ninth",
        cursor: { epoch: "epoch", seq: 239 },
      }),
    ).toBeUndefined();
    expect(ledger.summary()).toMatchObject({ contextBefore: 8, windowBefore: 0 });
    expect(ledger.summary().errors).toHaveLength(1);
  });
});

/** Unit input exercises visibility ownership, without pretending that a dispatched event proves browser hover. */
function sendNavigationPointer(type: "pointerdown" | "pointermove", x: number, y: number) {
  const event = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true });
  Object.defineProperty(event, "pointerType", { value: "mouse" });
  document.dispatchEvent(event);
}

describe("arrow destination action visibility", () => {
  it("keeps held destination actions through the next pointerdown until the next arrow activates", () => {
    const { result } = renderHook(() => useNavigationActionVisibility(true, "epoch-a"));
    act(() => {
      sendNavigationPointer("pointerdown", 1222, 164);
      result.current.start("middle");
    });
    expect(result.current.key).toBe("middle");
    // Discrete pointerdown flushes before pointerup/click. Hiding here disables the
    // same button that must receive the second click, before it can replace ownership.
    act(() => sendNavigationPointer("pointerdown", 1222, 164));
    expect(result.current.key).toBe("middle");
    act(() => result.current.start("oldest"));
    expect(result.current.key).toBe("oldest");
  });

  it("holds the actual arrow destination through the navigation context, but not content reveal or cancel", () => {
    const input = stickyInput([stickyUser("one", 1), stickyUser("two", 2), stickyUser("three", 3)]);
    const { result } = renderHook(() => {
      const navigation = useStickyPrompt(input);
      return { navigation, controls: usePromptNavigationControls(navigation) };
    });
    act(() => result.current.navigation.activate("three", -1));
    expect(result.current.controls.actionVisibleMessageId).toBe("two");
    expect(input.jumpToLoaded).toHaveBeenLastCalledWith("two", "pinned");
    act(() => result.current.navigation.next());
    expect(result.current.controls.actionVisibleMessageId).toBe("three");
    act(() => result.current.navigation.reveal());
    expect(result.current.controls.actionVisibleMessageId).toBeUndefined();
    act(() => result.current.navigation.previous());
    expect(result.current.controls.actionVisibleMessageId).toBe("two");
    act(() => result.current.navigation.cancel());
    expect(result.current.controls.actionVisibleMessageId).toBeUndefined();
  });

  it("keeps stationary layout events visible, then clears on actual mouse coordinate change", () => {
    const { result } = renderHook(() => useNavigationActionVisibility(true, "epoch-a"));
    act(() => {
      sendNavigationPointer("pointerdown", 1222, 545);
      result.current.start("destination");
    });
    expect(result.current.key).toBe("destination");
    act(() => sendNavigationPointer("pointermove", 1222, 545));
    expect(result.current.key).toBe("destination");
    act(() => sendNavigationPointer("pointermove", 1223, 545));
    expect(result.current.key).toBeNull();
    act(() => result.current.retarget("late-discovery"));
    expect(result.current.key).toBeNull();
  });

  it("replaces the destination, cancels on scroll or explicit cancellation, and isolates epochs and opt-out", () => {
    const { result, rerender } = renderHook(
      ({ enabled, epoch }) => useNavigationActionVisibility(enabled, epoch),
      { initialProps: { enabled: true, epoch: "epoch-a" } },
    );
    act(() => result.current.start("first"));
    act(() => result.current.start("second"));
    expect(result.current.key).toBe("second");
    act(() => document.dispatchEvent(new Event("wheel")));
    expect(result.current.key).toBeNull();
    act(() => result.current.start("third"));
    act(() => result.current.clear());
    expect(result.current.key).toBeNull();
    act(() => result.current.start("old-epoch"));
    rerender({ enabled: true, epoch: "epoch-b" });
    expect(result.current.key).toBeNull();
    act(() => result.current.start("new-epoch"));
    rerender({ enabled: false, epoch: "epoch-b" });
    expect(result.current.key).toBeNull();
    act(() => result.current.start("disabled"));
    expect(result.current.key).toBeNull();
  });

  it("retargets held discovery without reviving a cleared request and removes listeners on unmount", () => {
    const remove = vi.spyOn(document, "removeEventListener");
    const { result, unmount } = renderHook(() => useNavigationActionVisibility(true, null));
    act(() => result.current.start("discover-previous"));
    act(() => result.current.retarget("canonical-target"));
    expect(result.current.key).toBe("canonical-target");
    unmount();
    expect(remove).toHaveBeenCalledWith("pointermove", expect.any(Function), true);
    expect(remove).toHaveBeenCalledWith("wheel", expect.any(Function), true);
    remove.mockRestore();
  });
});

describe("actual prompt disclosure ownership", () => {
  beforeEach(() => vi.stubGlobal("React", React));
  afterEach(() => vi.unstubAllGlobals());
  it("reveals the clicked actual row rather than a different current selection", () => {
    const first = stickyUser("first", 1);
    const latest = stickyUser("latest", 3);
    const input = stickyInput([first, latest], stickyOutline([1, 3]));
    const { result } = renderHook(useStickyPrompt, { initialProps: input });
    expect(result.current.message?.id).toBe("latest");
    act(() => result.current.reveal("first"));
    expect(input.jumpToLoaded).toHaveBeenCalledExactlyOnceWith("first", "original");
    expect(result.current.message?.id).toBe("first");
    expect(input.outline.jumpToPrompt).not.toHaveBeenCalled();
  });

  it("retains expansion through row unmount and clears it across epoch changes without remounting the owner", () => {
    let scope = "session:epoch-1";
    const prepare = vi.fn();
    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <ActualPromptRowsProvider enabled scope={scope} availableHeight={500}>
          {children}
        </ActualPromptRowsProvider>
      );
    }
    const { result, rerender } = renderHook(() => useContext(ActualPromptRowsContext), {
      wrapper: Wrapper,
    });
    let release: (() => void) | undefined;
    act(() => {
      release = result.current!.registerViewport(prepare);
    });
    act(() => result.current!.toggleExpanded("original"));
    expect(prepare).toHaveBeenCalledExactlyOnceWith("original");
    expect(result.current!.expandedIds.has("original")).toBe(true);
    rerender();
    expect(result.current!.expandedIds.has("original")).toBe(true);
    scope = "session:epoch-2";
    rerender();
    expect(result.current!.expandedIds.size).toBe(0);
    scope = "session:epoch-1";
    rerender();
    expect(result.current!.expandedIds.size).toBe(0);
    act(() => release?.());
  });

  it("provides no collapse or pin policy when the feature is disabled", () => {
    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <ActualPromptRowsProvider enabled={false} scope="session:epoch" availableHeight={500}>
          {children}
        </ActualPromptRowsProvider>
      );
    }
    const { result } = renderHook(() => useContext(ActualPromptRowsContext), { wrapper: Wrapper });
    expect(result.current).toBeNull();
  });
});

interface NativeKeyboardEndpointHandlers {
  onStart(event: { height: number; progress: number }): void;
  onEnd(event: { height: number; progress: number }): void;
}
const endpointHarness = {
  handlers: null as NativeKeyboardEndpointHandlers | null,
  queue: [] as Array<() => void>,
};
function flushNativeEndpointQueue() {
  while (endpointHarness.queue.length) endpointHarness.queue.shift()!();
}
async function nativeEndpointReadingFixture() {
  vi.doMock("react-native-keyboard-controller", () => ({
    KeyboardController: { isVisible: () => false, state: () => ({ height: 0 }) },
    useGenericKeyboardHandler: (handlers: NativeKeyboardEndpointHandlers) => {
      endpointHarness.handlers = handlers;
    },
  }));
  vi.doMock("react-native-safe-area-context", () => ({
    useSafeAreaInsets: () => ({ bottom: 34, top: 0, left: 0, right: 0 }),
  }));
  vi.doMock("react-native-worklets", () => ({
    scheduleOnRN: (callback: (...args: unknown[]) => void, ...args: unknown[]) => {
      endpointHarness.queue.push(() => callback(...args));
    },
  }));
  const { usePublishDockReservation } =
    await import("@/keyboard/shift/internal/use-dock-reservation");
  let edge = 0;
  const items: StreamItem[] = [
    stickyUser("old", 1000),
    {
      id: "answer",
      kind: "assistant_message",
      text: "answer",
      timestamp: new Date(0),
      timelineCursor: { epoch: "epoch-1", seq: 1100 },
    },
    stickyUser("later", 1250),
  ];
  const geometry = new Map([
    ["old", { index: 0, y: 1000, height: 100 }],
    ["answer", { index: 1, y: 1100, height: 150 }],
    ["later", { index: 2, y: 1250, height: 53 }],
  ]);
  const mounted = new Set(items.map((item) => item.id));
  const readings: ReturnType<typeof resolveActualNativeReading>[] = [];
  const refresh = () =>
    readings.push(
      resolveActualNativeReading({
        items,
        geometry,
        mounted,
        offset: 1000,
        viewportHeight: 600,
        clippedLeading: edge,
        stickyEnabled: true,
      }),
    );
  const invalidate = vi.fn();
  const rendered = renderHook(() => {
    const snapshot = usePublishDockReservation(true, 0);
    useNativeReadingRefresh(snapshot, refresh, invalidate);
    return snapshot;
  });
  return {
    ...rendered,
    readings,
    invalidate,
    setEdge(value: number) {
      edge = value;
    },
    handlers: () => endpointHarness.handlers!,
  };
}
describe("native keyboard settlement reading refresh", () => {
  beforeEach(() => {
    endpointHarness.handlers = null;
    endpointHarness.queue = [];
  });
  afterEach(() => {
    vi.doUnmock("react-native-keyboard-controller");
    vi.doUnmock("react-native-safe-area-context");
    vi.doUnmock("react-native-worklets");
  });
  it("remeasures the final effective edge on end even when opening R is unchanged and no scroll/layout occurs", async () => {
    const fixture = await nativeEndpointReadingFixture();
    fixture.setEdge(100);
    act(() => {
      fixture.handlers().onStart({ height: 334, progress: 1 });
      flushNativeEndpointQueue();
    });
    expect(fixture.result.current).toEqual({ extent: 300, settledRevision: 0 });
    expect(fixture.readings.at(-1)?.rowId).toBe("answer");
    fixture.setEdge(300);
    act(() => {
      fixture.handlers().onEnd({ height: 334, progress: 1 });
      flushNativeEndpointQueue();
    });
    expect(fixture.result.current).toEqual({ extent: 300, settledRevision: 1 });
    expect(fixture.readings.map((reading) => reading.seq)).toEqual([1000, 1100, 1250]);
    expect(fixture.readings.at(-1)?.visibleUserIds).toEqual(["later"]);
    expect(fixture.invalidate).toHaveBeenCalledTimes(2);
    fixture.unmount();
  });
  it("refreshes once at closing completion and also publishes a cancelled zero-height completion", async () => {
    const fixture = await nativeEndpointReadingFixture();
    act(() => {
      fixture.handlers().onStart({ height: 334, progress: 1 });
      flushNativeEndpointQueue();
    });
    fixture.setEdge(300);
    act(() => {
      fixture.handlers().onEnd({ height: 334, progress: 1 });
      flushNativeEndpointQueue();
    });
    const openedCount = fixture.readings.length;
    act(() => {
      fixture.handlers().onStart({ height: 0, progress: 0 });
      flushNativeEndpointQueue();
    });
    expect(fixture.readings).toHaveLength(openedCount);
    fixture.setEdge(0);
    act(() => {
      fixture.handlers().onEnd({ height: 0, progress: 0 });
      flushNativeEndpointQueue();
    });
    expect(fixture.readings).toHaveLength(openedCount + 1);
    expect(fixture.result.current).toEqual({ extent: 0, settledRevision: 2 });
    act(() => {
      fixture.handlers().onStart({ height: 334, progress: 1 });
      flushNativeEndpointQueue();
    });
    act(() => {
      fixture.handlers().onEnd({ height: 0, progress: 0 });
      flushNativeEndpointQueue();
    });
    expect(fixture.result.current).toEqual({ extent: 0, settledRevision: 3 });
    expect(fixture.readings.at(-1)?.seq).toBe(1000);
    fixture.unmount();
  });
  it("does not refresh an unmounted consumer when queued native completion arrives", async () => {
    const fixture = await nativeEndpointReadingFixture();
    act(() => fixture.handlers().onEnd({ height: 334, progress: 1 }));
    const count = fixture.readings.length;
    fixture.unmount();
    act(flushNativeEndpointQueue);
    expect(fixture.readings).toHaveLength(count);
  });
});

describe("retained canonical reading context", () => {
  it("does not conflate repeated provider identities, interleaved USERs or coverage gaps", () => {
    const initial: StreamItem = {
      ...source,
      kind: "assistant_message",
      text: "answer",
      messageId: "shared",
    };
    const next: StreamItem = {
      ...initial,
      text: "answer extended",
      timelineCursor: { epoch: "epoch", seq: 55 },
    };
    const coverage = [{ epoch: "epoch", startSeq: 40, endSeq: 55 }];
    expect(canCoalesceCanonicalSource(initial, next, [next], coverage)).toBe(true);
    expect(
      canCoalesceCanonicalSource(initial, { ...next, id: "other-occurrence" }, [next], coverage),
    ).toBe(false);
    const changedTurn = { ...next, turnId: "next-turn" };
    const previous = planCanonicalReadingAttempt(undefined, initial, [initial], coverage, 0);
    const independent = planCanonicalReadingAttempt(
      previous,
      changedTurn,
      [changedTurn],
      coverage,
      0,
    );
    expect(independent.anchor).toBe(changedTurn);
    expect(independent.blocked).toBe(false);
    expect(
      canCoalesceCanonicalSource(
        initial,
        next,
        [next],
        [{ epoch: "epoch", startSeq: 51, endSeq: 55 }],
      ),
    ).toBe(false);
    const steer = { ...prompt, timelineCursor: { epoch: "epoch", seq: 52 } };
    expect(canCoalesceCanonicalSource(initial, next, [next, steer], coverage)).toBe(false);
    expect(
      resolveOrdinaryPromptContext(
        [prompt, initial],
        initial,
        [{ epoch: "wrong", startSeq: 4, endSeq: 55 }],
        40,
      ),
    ).toBeUndefined();
  });

  it("bounds all automatic work after unproved sequence advances until explicit retry", async () => {
    const owner = createCanonicalPromptContexts();
    const held = deferred<typeof proof>();
    let first = true;
    const fetchContext = vi.fn(async (current: StreamItem) => {
      if (first) {
        first = false;
        return await held.promise;
      }
      return {
        ...proof,
        sourceKey: canonicalPromptSourceKey(current),
        sourceEnd: current.timelineCursor!.seq,
      };
    });
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
    for (let seq = 51; seq <= 70; seq += 1)
      rerender({
        ...input,
        source: {
          ...source,
          text: `answer${"x".repeat(seq - 50)}`,
          timelineCursor: { epoch: "epoch", seq },
        },
      });
    await act(async () => held.resolve(proof));
    expect(result.current.contexts).toEqual([]);
    expect(result.current.error).toBe(true);
    expect(fetchContext).toHaveBeenCalledTimes(1);
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.contexts[0]?.sourceEnd).toBe(70));
    expect(result.current.error).toBe(false);
    expect(fetchContext).toHaveBeenCalledTimes(2);
    unmount();
    owner.dispose();
  });

  it("reuses ordinary coverage after the source probe without a backward context RPC", async () => {
    const owner = createCanonicalPromptContexts();
    const items = [prompt, source];
    const coverage = [{ epoch: "epoch", startSeq: 4, endSeq: 50 }];
    const probe: ContextPage = {
      epoch: "epoch",
      entries: [
        {
          provider: "mock",
          timestamp: new Date(0).toISOString(),
          seqStart: 40,
          seqEnd: 50,
          sourceSeqRanges: [{ startSeq: 40, endSeq: 50 }],
          collapsed: [],
          item: { type: "assistant_message", text: "answer" },
        },
      ],
      hasOlder: true,
      error: null,
      reset: false,
      staleCursor: false,
      gap: false,
    };
    const reader = vi.fn().mockResolvedValue(probe);
    owner.prepareSources("agent", {
      ...certifiedReadingRows(items, new Map([[source.id, 40]])),
      entries: [],
    });
    const lookup = { agentId: "agent", readPage: reader, projection: "canonical" as const };
    const { result, unmount } = renderHook(() =>
      useCanonicalPromptContext({
        owner,
        agentId: "agent",
        epoch: "epoch",
        source,
        ordinaryItems: items,
        coverage,
        enabled: true,
        lookup,
      }),
    );
    await waitFor(() => expect(result.current.contexts[0]?.prompt).toMatchObject(prompt));
    expect(result.current.contexts[0]?.sourceStart).toBe(40);
    expect(reader).toHaveBeenCalledExactlyOnceWith(
      {
        epoch: "epoch",
        cursor: 51,
        limit: 1,
        projection: "projected",
      },
      expect.any(AbortSignal),
    );
    expect(
      resolveOrdinaryPromptContext(
        items,
        source,
        [{ epoch: "epoch", startSeq: 20, endSeq: 50 }],
        40,
      ),
    ).toBeUndefined();
    // A later USER inside the assistant's expanded span is not its predecessor.
    const interleaved = { ...prompt, id: "steer", timelineCursor: { epoch: "epoch", seq: 45 } };
    expect(
      resolveOrdinaryPromptContext([prompt, interleaved, source], source, coverage, 40)?.prompt,
    ).toBe(prompt);
    unmount();
    owner.dispose();
  });

  it.each([
    { seq: 4, hasOlder: false },
    { seq: 60, hasOlder: true },
  ])(
    "ends unreachable context-only original reveal without paging or scrolling (seq=$seq, hasOlder=$hasOlder)",
    ({ seq, hasOlder }) => {
      const retained = stickyUser("unreachable-context", seq);
      const ordinarySource: StreamItem = {
        kind: "assistant_message",
        id: "ordinary-source",
        text: "answer",
        timestamp: new Date(0),
        timelineCursor: { epoch: "epoch-1", seq: 50 },
      };
      const input = {
        ...stickyInput([retained, ordinarySource], stickyOutline([seq])),
        contextManaged: true,
        indexed: false,
        contextOnlyIds: new Set([retained.id]),
        hasOlder,
        loadOlder: vi.fn(async () => false),
      };
      const { result, unmount } = renderHook(useStickyPrompt, { initialProps: input });
      act(() => result.current.reveal());
      expect(result.current.busy).toBe(false);
      expect(result.current.error).toBe(true);
      expect(input.loadOlder).not.toHaveBeenCalled();
      expect(input.outline.jumpToPrompt).not.toHaveBeenCalled();
      expect(input.jumpToLoaded).not.toHaveBeenCalled();
      expect(result.current.message).toBe(retained);
      unmount();
    },
  );

  it("ends context-only original reveal when the ordinary page owner exhausts without its target", async () => {
    const retained = stickyUser("missing-context", 4);
    const ordinarySource: StreamItem = {
      kind: "assistant_message",
      id: "ordinary-source",
      text: "answer",
      timestamp: new Date(0),
      timelineCursor: { epoch: "epoch-1", seq: 50 },
    };
    const held = deferred<boolean>();
    const input = {
      ...stickyInput([retained, ordinarySource], stickyOutline([4])),
      contextManaged: true,
      indexed: false,
      contextOnlyIds: new Set([retained.id]),
      hasOlder: true,
      loadOlder: vi.fn((_acceptance?: TimelinePageAcceptance) => held.promise),
    };
    const { result, rerender, unmount } = renderHook(useStickyPrompt, { initialProps: input });
    act(() => result.current.reveal());
    expect(result.current.busy).toBe(true);
    expect(input.loadOlder).toHaveBeenCalledTimes(1);
    expect(input.loadOlder.mock.calls[0]?.[0]?.signal.aborted).toBe(false);
    rerender({ ...input, hasOlder: false, progressKey: "exhausted-window" });
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(result.current.error).toBe(true);
    expect(result.current.message).toBe(retained);
    expect(result.current.discoveryStatus).toBe("cancelled");
    expect(input.loadOlder.mock.calls[0]?.[0]?.signal.aborted).toBe(true);
    expect(input.jumpToLoaded).not.toHaveBeenCalled();
    await act(async () => held.resolve(true));
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toBe(true);
    expect(result.current.discoveryStatus).toBe("cancelled");
    expect(result.current.message).toBe(retained);
    expect(input.jumpToLoaded).not.toHaveBeenCalled();
    expect(input.loadOlder).toHaveBeenCalledTimes(1);
    unmount();
  });

  it.each([false, true])(
    "materializes a context-only original through the window owner before scrolling (indexed=%s)",
    async (indexed) => {
      const retained = stickyUser("context-only", 4);
      const ordinarySource: StreamItem = {
        ...source,
        timelineCursor: { epoch: "epoch-1", seq: 50 },
      };
      const window = deferred<boolean>();
      const input = {
        ...stickyInput([retained, ordinarySource], stickyOutline([4])),
        contextManaged: true,
        indexed,
        contextOnlyIds: new Set([retained.id]),
        loadOlder: vi.fn(() => window.promise),
      };
      const { result, rerender, unmount } = renderHook(useStickyPrompt, { initialProps: input });
      expect(input.loadOlder).not.toHaveBeenCalled();
      act(() => result.current.reveal());
      expect(input.jumpToLoaded).not.toHaveBeenCalled();
      expect(result.current.busy).toBe(true);
      if (indexed) {
        expect(input.outline.jumpToPrompt).toHaveBeenCalledExactlyOnceWith(4, {
          scroll: false,
          source: "sticky",
          placement: "original",
        });
        expect(input.loadOlder).not.toHaveBeenCalled();
      } else {
        expect(input.outline.jumpToPrompt).not.toHaveBeenCalled();
        expect(input.loadOlder).toHaveBeenCalledTimes(1);
      }
      // The ordinary owner accepts the canonical target; mere sparse insertion did not.
      rerender({ ...input, contextOnlyIds: new Set<string>(), progressKey: "accepted-window" });
      await waitFor(() =>
        expect(input.jumpToLoaded).toHaveBeenCalledExactlyOnceWith(retained.id, "original"),
      );
      await act(async () => window.resolve(true));
      expect(result.current.error).toBe(false);
      expect(input.jumpToLoaded).toHaveBeenCalledTimes(1);
      unmount();
    },
  );

  it.each([false, true])(
    "leaves passive window and cache reads to the canonical owner (indexed=%s)",
    (indexed) => {
      const source: StreamItem = {
        kind: "assistant_message",
        id: "source",
        text: "answer",
        timestamp: new Date(0),
        timelineCursor: { epoch: "epoch-1", seq: 50 },
      };
      const loaded = stickyUser("user", 4);
      const fetchPrompt = vi.fn();
      const fetchContext = vi.fn();
      const input = {
        ...stickyInput([source], stickyOutline([4])),
        contextManaged: true,
        indexed,
        fetchPrompt,
        fetchContext,
      };
      const { result, rerender } = renderHook(useStickyPrompt, { initialProps: input });
      expect(input.loadOlder).not.toHaveBeenCalled();
      expect(input.outline.jumpToPrompt).not.toHaveBeenCalled();
      expect(fetchPrompt).not.toHaveBeenCalled();
      expect(fetchContext).not.toHaveBeenCalled();
      expect(result.current.message).toBeUndefined();
      rerender({ ...input, items: [loaded, source] });
      expect(result.current.message).toBe(loaded);
      expect(input.jumpToLoaded).not.toHaveBeenCalled();
      act(() => result.current.reveal());
      expect(input.jumpToLoaded).toHaveBeenCalledExactlyOnceWith("user", "original");
    },
  );

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

function certifiedReadingRows(
  items: readonly StreamItem[],
  starts: ReadonlyMap<string, number> = new Map(),
): AcceptedCanonicalSources {
  return {
    projection: "projected",
    epoch: "epoch",
    tail: items,
    head: [],
    cursor: { epoch: "epoch", startSeq: 4, endSeq: 100 },
    entries: items.flatMap((item) => {
      if (item.kind !== "assistant_message" || !item.timelineCursor) return [];
      const start = starts.get(item.id) ?? item.timelineCursor.seq;
      return [
        {
          seqStart: start,
          seqEnd: item.timelineCursor.seq,
          sourceSeqRanges: [{ startSeq: start, endSeq: item.timelineCursor.seq }],
          provider: "mock",
          turnId: item.turnId,
          item: { type: "assistant_message" as const, messageId: item.messageId, text: item.text },
        },
      ];
    }),
  };
}

describe("certified ordinary reading context", () => {
  const user: UserPrompt = {
    kind: "user_message",
    id: "user",
    text: "original",
    timestamp: new Date(0),
    timelineCursor: { epoch: "epoch", seq: 4 },
  };
  function answer(
    seq: number,
    id = `answer-${seq}`,
  ): Extract<StreamItem, { kind: "assistant_message" }> {
    return {
      kind: "assistant_message",
      id,
      messageId: "repeated-provider-id",
      text: `Answer ${seq}`,
      timestamp: new Date(0),
      timelineCursor: { epoch: "epoch", seq },
    };
  }

  it("traverses covered assistant rows forward and backward without an RPC or Loading pulse", async () => {
    const owner = createCanonicalPromptContexts();
    const first = answer(50);
    const second = answer(60);
    const third = answer(70);
    const steer = { ...user, id: "steer", timelineCursor: { epoch: "epoch", seq: 45 } };
    const items = [user, steer, first, second, third];
    const accepted = certifiedReadingRows(items, new Map([[first.id, 40]]));
    owner.prepareSources("agent", {
      ...accepted,
      entries: accepted.entries.map((entry) =>
        entry.seqEnd === 50
          ? Object.assign({}, entry, {
              sourceSeqRanges: [
                { startSeq: 40, endSeq: 44 },
                { startSeq: 46, endSeq: 50 },
              ],
            })
          : entry,
      ),
    });
    const fetchContext = vi.fn().mockRejectedValue(new Error("Unexpected context RPC"));
    const coverage = [{ epoch: "epoch", startSeq: 4, endSeq: 100 }];
    const input = {
      owner,
      agentId: "agent",
      epoch: "epoch",
      source: first,
      ordinaryItems: items,
      coverage,
      enabled: true,
      lookup: rawPromptLookup(first, fetchContext),
    };
    const observations: boolean[] = [];
    const fixture = renderHook(
      (props: typeof input) => {
        const context = useCanonicalPromptContext(props);
        observations.push(context.loading);
        return context;
      },
      { initialProps: input },
    );
    expect(fixture.result.current.contexts.at(-1)?.prompt).toBe(user);
    for (const source of [second, third, second, first]) {
      fixture.rerender({ ...input, source });
      const expected = source === first ? user : steer;
      expect(fixture.result.current.contexts.at(-1)?.prompt).toBe(expected);
      expect(fixture.result.current.loading).toBe(false);
      await act(async () => {});
    }
    expect(observations.every((loading) => !loading)).toBe(true);
    expect(fetchContext).not.toHaveBeenCalled();
    fixture.unmount();
    owner.dispose();
  });

  it("reuses an off-window predecessor backward and forward across an assistant-only window without another read or Loading", async () => {
    const owner = createCanonicalPromptContexts();
    const initial = { ...answer(500), turnId: "turn-500" };
    const earlier = { ...answer(450), turnId: "turn-450" };
    const earliest = { ...answer(440), turnId: "turn-440" };
    const later = { ...answer(550), turnId: "turn-550" };
    const items: StreamItem[] = [earliest, earlier, initial, later];
    const accepted = {
      ...certifiedReadingRows(items),
      cursor: { epoch: "epoch", startSeq: 400, endSeq: 600 },
    };
    owner.prepareSources("agent", accepted);
    const offWindow: UserPrompt = {
      ...user,
      id: "off-window-user",
      timelineCursor: { epoch: "epoch", seq: 20 },
    };
    const contextPage: ContextPage = {
      epoch: "epoch",
      entries: [],
      hasOlder: true,
      error: null,
      reset: false,
      staleCursor: false,
      gap: false,
    };
    const earlierEntries = accepted.entries
      .filter((entry) => entry.seqEnd < 500)
      .map((entry) =>
        Object.assign({}, entry, {
          sourceSeqRanges: entry.sourceSeqRanges ?? [],
          collapsed: [],
          timestamp: new Date(0).toISOString(),
        }),
      );
    const reader = vi
      .fn()
      .mockResolvedValueOnce({
        ...contextPage,
        entries: [
          {
            provider: "mock",
            turnId: initial.turnId,
            seqStart: 500,
            seqEnd: 500,
            sourceSeqRanges: [{ startSeq: 500, endSeq: 500 }],
            collapsed: [],
            timestamp: new Date(0).toISOString(),
            item: { type: "assistant_message", messageId: initial.messageId, text: initial.text },
          },
        ],
      })
      .mockResolvedValueOnce({
        ...contextPage,
        hasOlder: false,
        entries: [
          {
            provider: "mock",
            seqStart: 20,
            seqEnd: 20,
            sourceSeqRanges: [{ startSeq: 20, endSeq: 20 }],
            collapsed: [],
            timestamp: new Date(0).toISOString(),
            item: { type: "user_message", text: offWindow.text },
          },
          ...earlierEntries,
        ],
      });
    const input = {
      owner,
      agentId: "agent",
      epoch: "epoch",
      source: initial,
      ordinaryItems: items,
      coverage: [{ epoch: "epoch", startSeq: 400, endSeq: 600 }],
      enabled: true,
      lookup: { agentId: "agent", readPage: reader, projection: "canonical" as const },
    };
    const loading: boolean[] = [];
    const fixture = renderHook(
      (props: typeof input) => {
        const result = useCanonicalPromptContext(props);
        loading.push(result.loading);
        return result;
      },
      { initialProps: input },
    );
    await waitFor(() =>
      expect(fixture.result.current.contexts.at(-1)?.prompt.timelineCursor?.seq).toBe(20),
    );
    expect(reader).toHaveBeenCalledTimes(2);
    loading.length = 0;
    for (const source of [earlier, earliest, later, earlier, initial]) {
      fixture.rerender({ ...input, source });
      expect(fixture.result.current.contexts.at(-1)?.prompt.timelineCursor?.seq).toBe(20);
      expect(fixture.result.current.loading).toBe(false);
      await act(async () => {});
    }
    expect(loading.length).toBeGreaterThan(0);
    expect(loading.every((value) => !value)).toBe(true);
    expect(reader).toHaveBeenCalledTimes(2);
    expect(items.some((item) => item.kind === "user_message")).toBe(false);
    fixture.unmount();
    owner.dispose();
  });

  it("uses an exact cached source without a transient Loading render", async () => {
    const owner = createCanonicalPromptContexts();
    const source = answer(50);
    const proof = {
      sourceKey: canonicalPromptSourceKey(source),
      sourceStart: 40,
      sourceEnd: 50,
      prompt: user,
    };
    const seed = {};
    await requestPromptFixture(owner, {
      agentId: "agent",
      channel: seed,
      source,
      signal: new AbortController().signal,
      fetchContext: async () => proof,
    });
    const fetchContext = vi.fn().mockRejectedValue(new Error("Unexpected cache miss"));
    const observations: boolean[] = [];
    const fixture = renderHook(() => {
      const context = useCanonicalPromptContext({
        owner,
        agentId: "agent",
        epoch: "epoch",
        source,
        enabled: true,
        lookup: rawPromptLookup(source, fetchContext),
      });
      observations.push(context.loading);
      return context;
    });
    await act(async () => {});
    expect(fixture.result.current.contexts).toMatchObject([proof]);
    expect(observations.every((loading) => !loading)).toBe(true);
    expect(fetchContext).not.toHaveBeenCalled();
    fixture.unmount();
    owner.release(seed);
    owner.dispose();
  });

  it("retires a held miss when accepted ordinary proof arrives and fences its late completion", async () => {
    const owner = createCanonicalPromptContexts();
    const source = answer(100);
    const prior = answer(50);
    const seed = {};
    await requestPromptFixture(owner, {
      agentId: "agent",
      channel: seed,
      source: prior,
      signal: new AbortController().signal,
      fetchContext: async () => ({
        sourceKey: canonicalPromptSourceKey(prior),
        sourceStart: 40,
        sourceEnd: 50,
        prompt: user,
      }),
    });
    const held = deferred<{
      sourceKey: string;
      sourceStart: number;
      sourceEnd: number;
      prompt: UserPrompt;
    }>();
    const fetchContext = vi.fn((_source: StreamItem, _signal: AbortSignal) => held.promise);
    const input = {
      owner,
      agentId: "agent",
      epoch: "epoch",
      source,
      ordinaryItems: [source] as StreamItem[],
      coverage: [{ epoch: "epoch", startSeq: 90, endSeq: 100 }],
      enabled: true,
      lookup: rawPromptLookup(source, fetchContext),
    };
    const fixture = renderHook(useCanonicalPromptContext, { initialProps: input });
    await waitFor(() => expect(fetchContext).toHaveBeenCalledTimes(1));
    expect(fixture.result.current.loading).toBe(true);
    expect(owner.read("agent", "epoch")[0]?.prompt).toMatchObject(user);
    const items = [user, source];
    act(() =>
      owner.prepareSources("agent", certifiedReadingRows(items, new Map([[source.id, 90]]))),
    );
    fixture.rerender({
      ...input,
      ordinaryItems: items,
      coverage: [{ epoch: "epoch", startSeq: 4, endSeq: 100 }],
    });
    expect(fetchContext.mock.calls[0]![1].aborted).toBe(true);
    expect(fixture.result.current.loading).toBe(false);
    expect(fixture.result.current.contexts.at(-1)?.sourceStart).toBe(90);
    await act(async () =>
      held.resolve({
        sourceKey: canonicalPromptSourceKey(source),
        sourceStart: 95,
        sourceEnd: 100,
        prompt: { ...user, id: "stale" },
      }),
    );
    expect(fixture.result.current.contexts.at(-1)?.prompt).toBe(user);
    expect(owner.read("agent", "epoch").some((entry) => entry.prompt.id === "stale")).toBe(false);
    expect(fetchContext).toHaveBeenCalledTimes(1);
    fixture.unmount();
    owner.dispose();
  });

  it("settles an unproved advancing occurrence only from current local metadata without buying another network budget", async () => {
    const owner = createCanonicalPromptContexts();
    const original = answer(50, "advancing");
    const next = {
      ...original,
      text: "changed answer",
      timelineCursor: { epoch: "epoch", seq: 55 },
    };
    const held = deferred<{
      sourceKey: string;
      sourceStart: number;
      sourceEnd: number;
      prompt: UserPrompt;
    }>();
    const fetchContext = vi.fn((_source: StreamItem, _signal: AbortSignal) => held.promise);
    const input = {
      owner,
      agentId: "agent",
      epoch: "epoch",
      source: original,
      ordinaryItems: [original] as StreamItem[],
      coverage: [{ epoch: "epoch", startSeq: 50, endSeq: 50 }],
      enabled: true,
      lookup: rawPromptLookup(original, fetchContext),
    };
    const fixture = renderHook(useCanonicalPromptContext, { initialProps: input });
    await waitFor(() => expect(fetchContext).toHaveBeenCalledTimes(1));
    fixture.rerender({
      ...input,
      source: next,
      ordinaryItems: [next],
      coverage: [{ epoch: "epoch", startSeq: 55, endSeq: 55 }],
    });
    expect(fixture.result.current.error).toBe(true);
    expect(fetchContext.mock.calls[0]![1].aborted).toBe(true);
    const items = [user, next];
    owner.prepareSources("agent", certifiedReadingRows(items, new Map([[next.id, 40]])));
    fixture.rerender({
      ...input,
      source: next,
      ordinaryItems: items,
      coverage: [{ epoch: "epoch", startSeq: 4, endSeq: 55 }],
    });
    expect(fixture.result.current.contexts.at(-1)?.prompt).toBe(user);
    expect(fixture.result.current.loading).toBe(false);
    expect(fixture.result.current.error).toBe(false);
    await act(async () =>
      held.resolve({
        sourceKey: canonicalPromptSourceKey(original),
        sourceStart: 40,
        sourceEnd: 50,
        prompt: { ...user, id: "stale" },
      }),
    );
    expect(owner.read("agent", "epoch").some((entry) => entry.prompt.id === "stale")).toBe(false);
    const unresolved = { ...next, timelineCursor: { epoch: "epoch", seq: 56 } };
    fixture.rerender({
      ...input,
      source: unresolved,
      ordinaryItems: [unresolved],
      coverage: [{ epoch: "epoch", startSeq: 56, endSeq: 56 }],
    });
    expect(fixture.result.current.error).toBe(true);
    expect(fetchContext).toHaveBeenCalledTimes(1);
    fixture.unmount();
    owner.dispose();
  });

  it("reuses retained proof only across certified coverage without an intervening earlier USER", () => {
    const source = answer(80);
    const items = [source];
    const metadata = reconcileCanonicalSourceMetadata(
      EMPTY_SOURCE_METADATA,
      certifiedReadingRows(items, new Map([[source.id, 70]])),
    );
    const anchor = {
      sourceKey: "different occurrence",
      sourceStart: 40,
      sourceEnd: 50,
      prompt: user,
    };
    const input = {
      source,
      items,
      metadata,
      contexts: [anchor],
      exactContext: undefined,
      coverage: [{ epoch: "epoch", startSeq: 40, endSeq: 80 }],
    };
    expect(resolveKnownPromptContext(input)?.prompt).toBe(user);
    const laterProof = { ...anchor, sourceStart: 90, sourceEnd: 95 };
    const reverse = {
      ...input,
      contexts: [laterProof],
      coverage: [{ epoch: "epoch", startSeq: 70, endSeq: 80 }],
    };
    expect(resolveKnownPromptContext(reverse)?.prompt).toBe(user);
    expect(
      resolveKnownPromptContext({
        ...reverse,
        coverage: [
          { epoch: "epoch", startSeq: 70, endSeq: 74 },
          { epoch: "epoch", startSeq: 76, endSeq: 80 },
        ],
      }),
    ).toBeUndefined();
    const contradiction = {
      ...user,
      id: "contradiction",
      timelineCursor: { epoch: "epoch", seq: 85 },
    };
    expect(
      resolveKnownPromptContext({ ...reverse, items: [source, contradiction] }),
    ).toBeUndefined();
    const afterCertificate = { ...contradiction, timelineCursor: { epoch: "epoch", seq: 95 } };
    expect(
      resolveKnownPromptContext({ ...reverse, items: [source, afterCertificate] })?.prompt,
    ).toBe(user);
    const tooLate = {
      ...laterProof,
      prompt: { ...user, timelineCursor: { epoch: "epoch", seq: 70 } },
    };
    expect(resolveKnownPromptContext({ ...reverse, contexts: [tooLate] })).toBeUndefined();
    expect(
      resolveKnownPromptContext({
        ...input,
        coverage: [
          { epoch: "epoch", startSeq: 40, endSeq: 55 },
          { epoch: "epoch", startSeq: 57, endSeq: 80 },
        ],
      }),
    ).toBeUndefined();
    const intervening = { ...user, id: "intervening", timelineCursor: { epoch: "epoch", seq: 60 } };
    expect(resolveKnownPromptContext({ ...input, items: [intervening, source] })?.prompt).toBe(
      intervening,
    );
    expect(
      resolveKnownPromptContext({
        ...input,
        source: { ...source, timelineCursor: { epoch: "other", seq: 80 } },
      }),
    ).toBeUndefined();
  });

  it("rejects holes, overlapping occurrences and unknown expanded ranges without conflating repeated IDs", () => {
    const first = answer(50, "first");
    const later = answer(80, "later");
    const page = certifiedReadingRows(
      [first, later],
      new Map([
        [first.id, 40],
        [later.id, 70],
      ]),
    );
    const metadata = reconcileCanonicalSourceMetadata(EMPTY_SOURCE_METADATA, page);
    expect(resolveCanonicalSourceMetadata(metadata, first)?.startSeq).toBe(40);
    expect(resolveCanonicalSourceMetadata(metadata, later)?.startSeq).toBe(70);
    const hole = { ...first, timelineCursor: { epoch: "epoch", seq: 45 } };
    const disjoint = reconcileCanonicalSourceMetadata(EMPTY_SOURCE_METADATA, {
      ...page,
      tail: [first],
      entries: [
        {
          ...page.entries[0]!,
          sourceSeqRanges: [
            { startSeq: 40, endSeq: 44 },
            { startSeq: 46, endSeq: 50 },
          ],
        },
      ],
    });
    expect(disjoint).toHaveLength(1);
    // Synthetic reading-cursor binding isolates actual-range membership from the
    // ordinary row's end cursor; the enclosing 40..50 range is insufficient.
    expect(
      resolveCanonicalSourceMetadata(
        disjoint.map((entry) => Object.assign({}, entry, { revision: hole })),
        hole,
      ),
    ).toBeUndefined();
    const ambiguous = reconcileCanonicalSourceMetadata(EMPTY_SOURCE_METADATA, {
      ...page,
      tail: [first],
      entries: [
        page.entries[0]!,
        { ...page.entries[0]!, seqStart: 49, sourceSeqRanges: [{ startSeq: 49, endSeq: 50 }] },
      ],
    });
    expect(resolveCanonicalSourceMetadata(ambiguous, first)).toBeUndefined();
    const unknown = reconcileCanonicalSourceMetadata(EMPTY_SOURCE_METADATA, {
      ...page,
      entries: [{ ...page.entries[0]!, sourceSeqRanges: undefined }],
    });
    expect(resolveCanonicalSourceMetadata(unknown, first)).toBeUndefined();
    const delta = reconcileCanonicalSourceMetadata(EMPTY_SOURCE_METADATA, {
      ...page,
      projection: "canonical",
    });
    expect(delta).toEqual([]);
  });

  it("rejects an exact cached certificate contradicted by an ordinary USER across a coverage gap at resolution and admission", async () => {
    const owner = createCanonicalPromptContexts();
    const source = answer(500);
    const prior: UserPrompt = { ...user, timelineCursor: { epoch: "epoch", seq: 20 } };
    const payload = {
      sourceKey: canonicalPromptSourceKey(source),
      sourceStart: 500,
      sourceEnd: 500,
      prompt: prior,
    };
    const seed = {};
    await requestPromptFixture(owner, {
      agentId: "agent",
      channel: seed,
      source,
      signal: new AbortController().signal,
      fetchContext: async () => payload,
    });
    const proof = owner.read("agent", "epoch", seed)[0]!;
    const intervening: UserPrompt = {
      ...user,
      id: "new-user",
      timelineCursor: { epoch: "epoch", seq: 450 },
    };
    const page = {
      ...certifiedReadingRows([intervening, source]),
      cursor: {
        epoch: "epoch",
        startSeq: 490,
        endSeq: 600,
        retainedRanges: [{ startSeq: 400, endSeq: 460 }],
      },
    };
    owner.prepareSources("agent", page);
    expect(owner.preview("agent", source)).toBeUndefined();
    expect(owner.readExactContext("agent", source)).toBeUndefined();
    owner.prepareSources("agent", { ...page, tail: [source] });
    expect(owner.read("agent", "epoch", seed)).toEqual([proof]);
    expect(owner.isSupportedContext("agent", proof)).toBe(false);
    expect(owner.isSupportedContext("agent", { ...proof })).toBe(false);
    expect(owner.preview("agent", source)).toBeUndefined();
    const fetchContext = vi.fn(async () => payload);
    await expect(
      requestPromptFixture(owner, {
        agentId: "agent",
        channel: {},
        source,
        signal: new AbortController().signal,
        knownContext: { ...proof },
        lookupAllowed: false,
        fetchContext,
      }),
    ).rejects.toThrow("Reading context changed");
    expect(fetchContext).not.toHaveBeenCalled();
    const channel = {};
    await expect(
      requestPromptFixture(owner, {
        agentId: "agent",
        channel,
        source,
        signal: new AbortController().signal,
        fetchContext: async () => ({ ...payload, prompt: intervening }),
      }),
    ).resolves.toMatchObject(intervening);
    expect(owner.readExactContext("agent", source)?.prompt.timelineCursor?.seq).toBe(450);
    expect(owner.isSupportedContext("agent", proof)).toBe(false);
    expect(owner.read("agent", "epoch", seed)).toEqual([proof]);
    owner.dispose();
  });

  it("keeps derived retained relations invalid after their contradicting USER leaves without evicting the prompt", async () => {
    const owner = createCanonicalPromptContexts();
    const source = answer(500);
    const target = answer(440);
    const prior: UserPrompt = { ...user, timelineCursor: { epoch: "epoch", seq: 20 } };
    const seed = {};
    await requestPromptFixture(owner, {
      agentId: "agent",
      channel: seed,
      source,
      signal: new AbortController().signal,
      fetchContext: async () => ({
        sourceKey: canonicalPromptSourceKey(source),
        sourceStart: 500,
        sourceEnd: 500,
        prompt: prior,
      }),
    });
    const proof = owner.read("agent", "epoch", seed)[0]!;
    const page = {
      ...certifiedReadingRows([target, source]),
      cursor: { epoch: "epoch", startSeq: 400, endSeq: 600 },
    };
    owner.prepareSources("agent", page);
    const preview = owner.preview("agent", target);
    expect(preview?.prompt.timelineCursor?.seq).toBe(20);
    if (!preview) throw new Error("Expected certified reverse preview");
    expect(owner.isSupportedContext("agent", preview)).toBe(false);
    const channel = {};
    await owner.request({
      agentId: "agent",
      channel,
      source: target,
      signal: new AbortController().signal,
      lookup: undefined,
      lookupAllowed: false,
      retryToken: 0,
    });
    const admitted = owner.read("agent", "epoch", channel)[0]!;
    const contradiction: UserPrompt = {
      ...user,
      id: "intervening",
      timelineCursor: { epoch: "epoch", seq: 450 },
    };
    owner.prepareSources("agent", { ...page, tail: [target, contradiction, source] });
    owner.prepareSources("agent", page);
    expect(owner.isSupportedContext("agent", admitted)).toBe(false);
    expect(owner.isSupportedContext("agent", proof)).toBe(false);
    expect(owner.preview("agent", target)).toBeUndefined();
    expect(owner.read("agent", "epoch", seed)).toEqual([proof]);
    expect(owner.read("agent", "epoch", channel)).toEqual([admitted]);
    owner.dispose();
  });

  it("preserves competing-source ambiguity before and after the descriptor bound including exact-cache admission", async () => {
    const source = answer(500, "ambiguous-source");
    const prior: UserPrompt = { ...user, timelineCursor: { epoch: "epoch", seq: 20 } };
    const proof = {
      sourceKey: canonicalPromptSourceKey(source),
      sourceStart: 490,
      sourceEnd: 500,
      prompt: prior,
    };
    for (const following of [255, 300]) {
      const extras = Array.from({ length: following }, (_, index) => answer(600 + index));
      const rows = [source, ...extras];
      const page = {
        ...certifiedReadingRows(rows, new Map([[source.id, 400]])),
        cursor: { epoch: "epoch", startSeq: 400, endSeq: 1000 },
      };
      const rival = {
        ...page.entries[0]!,
        seqStart: 490,
        sourceSeqRanges: [{ startSeq: 490, endSeq: 500 }],
      };
      const competing = { ...page, entries: [page.entries[0]!, rival, ...page.entries.slice(1)] };
      const initial = reconcileCanonicalSourceMetadata(EMPTY_SOURCE_METADATA, {
        ...page,
        entries: [page.entries[0]!],
      });
      const repeated = reconcileCanonicalSourceMetadata(initial, {
        ...page,
        entries: [page.entries[0]!],
      });
      expect(resolveCanonicalSourceMetadata(repeated, source)?.startSeq).toBe(400);
      const acrossPages = reconcileCanonicalSourceMetadata(initial, {
        ...page,
        entries: [rival, ...page.entries.slice(1)],
      });
      expect(hasCanonicalSourceEvidence(acrossPages, source)).toBe(true);
      expect(resolveCanonicalSourceMetadata(acrossPages, source)).toBeUndefined();
      const metadata = reconcileCanonicalSourceMetadata(EMPTY_SOURCE_METADATA, competing);
      expect(metadata).toHaveLength(Math.min(following, 256));
      expect(metadata.some((entry) => entry.revision === source)).toBe(false);
      expect(hasCanonicalSourceEvidence(metadata, source)).toBe(true);
      expect(resolveCanonicalSourceMetadata(metadata, source)).toBeUndefined();
      const unchanged = reconcileCanonicalSourceMetadata(metadata, { ...page, entries: [] });
      expect(hasCanonicalSourceEvidence(unchanged, source)).toBe(true);
      expect(resolveCanonicalSourceMetadata(unchanged, source)).toBeUndefined();
      const clean = reconcileCanonicalSourceMetadata(EMPTY_SOURCE_METADATA, {
        ...page,
        entries: [page.entries[0]!],
      });
      expect(resolveCanonicalSourceMetadata(clean, source)?.startSeq).toBe(400);
      const removed = reconcileCanonicalSourceMetadata(metadata, {
        ...page,
        entries: [],
        tail: extras,
      });
      expect(hasCanonicalSourceEvidence(removed, source)).toBe(false);
      const owner = createCanonicalPromptContexts();
      await requestPromptFixture(owner, {
        agentId: "agent",
        channel: {},
        source,
        signal: new AbortController().signal,
        fetchContext: async () => proof,
      });
      owner.prepareSources("agent", competing);
      expect(owner.readExactContext("agent", source)).toBeUndefined();
      expect(
        resolveKnownPromptContext({
          source,
          items: rows,
          metadata,
          coverage: [{ epoch: "epoch", startSeq: 400, endSeq: 1000 }],
          contexts: owner.read("agent", "epoch"),
          exactContext: proof,
        }),
      ).toBeUndefined();
      const fetchContext = vi.fn(async () => undefined);
      const channel = {};
      const request = {
        agentId: "agent",
        channel,
        source,
        signal: new AbortController().signal,
        knownContext: proof,
        fetchContext,
        retryToken: 0,
      };
      await expect(requestPromptFixture(owner, request)).rejects.toThrow("Reading context changed");
      expect(fetchContext).toHaveBeenCalledTimes(1);
      expect(owner.read("agent", "epoch", channel)).toEqual([]);
      await expect(requestPromptFixture(owner, request)).rejects.toThrow("Reading context changed");
      expect(fetchContext).toHaveBeenCalledTimes(1);
      expect(owner.read("agent", "epoch", channel)).toEqual([]);
      owner.dispose();
    }
  });

  it("keeps descriptor retention bounded to the resulting ordinary window", () => {
    const rows = Array.from({ length: 300 }, (_, index) => answer(index + 100));
    const page = {
      ...certifiedReadingRows(rows),
      cursor: { epoch: "epoch", startSeq: 100, endSeq: 399 },
    };
    const metadata = reconcileCanonicalSourceMetadata(EMPTY_SOURCE_METADATA, page);
    expect(metadata).toHaveLength(256);
    expect(metadata[0]?.startSeq).toBe(144);
    expect(rows).toHaveLength(300);
    const tail = rows.slice(-2);
    const pruned = reconcileCanonicalSourceMetadata(metadata, {
      ...page,
      entries: [],
      tail,
      cursor: { epoch: "epoch", startSeq: 398, endSeq: 399 },
    });
    expect(pruned.map((entry) => entry.revision)).toEqual(tail);
    expect(pruned[0]).toBe(metadata.at(-2));
  });

  it("uses the full ordinary USER revision before local slicing instead of an older retained copy", async () => {
    const owner = createCanonicalPromptContexts();
    const source = answer(50);
    const seed = {};
    await requestPromptFixture(owner, {
      agentId: "agent",
      channel: seed,
      source,
      signal: new AbortController().signal,
      fetchContext: async () => ({
        sourceKey: canonicalPromptSourceKey(source),
        sourceStart: 40,
        sourceEnd: 50,
        prompt: user,
      }),
    });
    const updated = { ...user, text: "updated canonical prompt" };
    const items = [updated, source];
    owner.prepareSources("agent", certifiedReadingRows(items, new Map([[source.id, 40]])));
    const fetchContext = vi.fn().mockRejectedValue(new Error("Unexpected revision read"));
    const fixture = renderHook(() =>
      useCanonicalPromptContext({
        owner,
        agentId: "agent",
        epoch: "epoch",
        source,
        ordinaryItems: items,
        coverage: [{ epoch: "epoch", startSeq: 4, endSeq: 100 }],
        enabled: true,
        lookup: rawPromptLookup(source, fetchContext),
      }),
    );
    expect(fixture.result.current.contexts.at(-1)?.prompt).toBe(updated);
    expect(fixture.result.current.loading).toBe(false);
    await act(async () => {});
    expect(fetchContext).not.toHaveBeenCalled();
    fixture.unmount();
    owner.dispose();
  });

  it("invalidates changed live revisions and scopes descriptors to owner, epoch and demand", () => {
    const source = answer(50);
    const owner = createCanonicalPromptContexts();
    const independent = createCanonicalPromptContexts();
    const page = certifiedReadingRows([user, source], new Map([[source.id, 40]]));
    owner.prepareSources("agent", page);
    expect(owner.readSourceMetadata("agent", "epoch")).toHaveLength(1);
    expect(independent.readSourceMetadata("agent", "epoch")).toEqual([]);
    const live = { ...source, text: "changed live content" };
    owner.prepareSources("agent", { ...page, entries: [], tail: [user, live] });
    expect(owner.readSourceMetadata("agent", "epoch")).toEqual([]);
    owner.prepareSources("agent", page);
    owner.setEpoch("agent", "next-epoch");
    expect(owner.readSourceMetadata("agent", "epoch")).toEqual([]);
    owner.prepareSources("agent", page);
    owner.retainAgents([]);
    owner.prepareSources("agent", page);
    expect(owner.readSourceMetadata("agent", "epoch")).toEqual([]);
    owner.dispose();
    independent.dispose();
  });
});

describe("canonical prompt admission ownership", () => {
  const epoch = "epoch";
  const agentId = "agent";
  const prior: UserPrompt = {
    kind: "user_message",
    id: "P20",
    text: "Prior prompt",
    timestamp: new Date(0),
    timelineCursor: { epoch, seq: 20 },
  };
  const newer: UserPrompt = {
    ...prior,
    id: "P450",
    text: "Newer prompt",
    timelineCursor: { epoch, seq: 450 },
  };
  function answer(seq: number): Extract<StreamItem, { kind: "assistant_message" }> {
    return {
      kind: "assistant_message",
      id: `answer-${seq}`,
      messageId: `message-${seq}`,
      text: `Answer ${seq}`,
      timestamp: new Date(0),
      timelineCursor: { epoch, seq },
    };
  }
  function accepted(
    owner: ReturnType<typeof createCanonicalPromptContexts>,
    items: readonly StreamItem[],
    start = 400,
    end = 1000,
  ) {
    owner.prepareSources(agentId, {
      ...certifiedReadingRows(items),
      cursor: { epoch, startSeq: start, endSeq: end },
    });
    owner.publishSources();
  }
  function request(
    owner: ReturnType<typeof createCanonicalPromptContexts>,
    source: StreamItem,
    channel: object,
    rawLookup?: ReturnType<typeof rawPromptLookup>,
    retryToken = 0,
    lookupAllowed = true,
  ) {
    return owner.request({
      agentId,
      source,
      channel,
      lookup: rawLookup,
      lookupAllowed,
      retryToken,
      signal: new AbortController().signal,
    });
  }
  function lookup(source: StreamItem, prompt = prior) {
    const fixture = rawPromptLookup(source, async () => ({
      sourceKey: canonicalPromptSourceKey(source),
      sourceStart: source.timelineCursor!.seq,
      sourceEnd: source.timelineCursor!.seq,
      prompt,
    }));
    return { ...fixture, readPage: vi.fn(fixture.readPage) };
  }

  function occurrencePage(entries: ContextEntry[], hasOlder = false): ContextPage {
    return { epoch, entries, hasOlder, error: null, reset: false, staleCursor: false, gap: false };
  }
  function occurrenceEntry(
    source: Extract<StreamItem, { kind: "assistant_message" }>,
    start: number,
  ): ContextEntry {
    const end = source.timelineCursor!.seq;
    return {
      provider: "mock",
      timestamp: new Date(0).toISOString(),
      seqStart: start,
      seqEnd: end,
      sourceSeqRanges:
        start === 400
          ? [
              { startSeq: 400, endSeq: 449 },
              { startSeq: 451, endSeq: end },
            ]
          : [{ startSeq: start, endSeq: end }],
      collapsed: [],
      item: { type: "assistant_message", messageId: source.messageId, text: source.text },
    };
  }
  function occurrencePrompt(prompt: UserPrompt): ContextEntry {
    const seq = prompt.timelineCursor!.seq;
    return {
      provider: "mock",
      timestamp: new Date(0).toISOString(),
      seqStart: seq,
      seqEnd: seq,
      sourceSeqRanges: [{ startSeq: seq, endSeq: seq }],
      collapsed: [],
      item: { type: "user_message", text: prompt.text },
    };
  }
  function acceptOccurrence(
    owner: ReturnType<typeof createCanonicalPromptContexts>,
    source: Extract<StreamItem, { kind: "assistant_message" }>,
    start: number,
    options: { users?: readonly UserPrompt[]; complete?: boolean } = {},
  ) {
    const rows = [...(options.users ?? []), source];
    const cursor = {
      epoch,
      startSeq: options.complete ? 20 : 490,
      endSeq: 600,
      retainedRanges:
        !options.complete && options.users?.length
          ? [
              { startSeq: 20, endSeq: 20 },
              { startSeq: 450, endSeq: 460 },
            ]
          : [],
    };
    const entry = occurrenceEntry(source, start);
    owner.prepareSources(agentId, { ...certifiedReadingRows(rows), entries: [entry], cursor });
    owner.publishSources();
    // A new ordinary revision must establish a UNIQUE changed start. Reusing the
    // same revision with rival descriptors would only exercise ambiguity rejection.
    expect(
      resolveCanonicalSourceMetadata(owner.readSourceMetadata(agentId, epoch), source)?.startSeq,
    ).toBe(start);
  }
  async function verifyHeldOccurrence(outcome: "prompt" | "exhausted") {
    const owner = createCanonicalPromptContexts();
    const source = answer(500);
    const replacement = { ...source };
    acceptOccurrence(owner, source, 500);
    const held = deferred<ContextPage>();
    const started = deferred<void>();
    let start = 500;
    const readPage = vi.fn(
      async (
        input: Parameters<ReturnType<typeof rawPromptLookup>["readPage"]>[0],
      ): Promise<ContextPage> => {
        if (input.limit === 1) return occurrencePage([occurrenceEntry(source, start)], true);
        if (start === 400) return occurrencePage([occurrencePrompt(prior)]);
        started.resolve();
        return held.promise;
      },
    );
    const raw = { agentId, readPage, projection: "canonical" as const };
    const channel = {};
    const pending = request(owner, source, channel, raw);
    const rejected = expect(pending).rejects.toThrow("Reading context changed");
    await started.promise;
    acceptOccurrence(owner, replacement, 400);
    expect(canonicalPromptSourceKey(replacement)).toBe(canonicalPromptSourceKey(source));
    held.resolve(occurrencePage(outcome === "prompt" ? [occurrencePrompt(newer)] : []));
    await rejected;
    expect(owner.read(agentId, epoch, channel)).toEqual([]);
    expect(readPage).toHaveBeenCalledTimes(2);
    await expect(request(owner, replacement, channel, raw)).rejects.toThrow(
      "Reading context changed",
    );
    expect(readPage).toHaveBeenCalledTimes(2);
    start = 400;
    await request(owner, replacement, channel, raw, 1);
    expect(readPage).toHaveBeenCalledTimes(4);
    expect(readPage.mock.calls[2]![0]).toEqual({
      epoch,
      cursor: 501,
      limit: 1,
      projection: "projected",
    });
    expect(owner.read(agentId, epoch, channel).at(-1)).toMatchObject({
      sourceStart: 400,
      sourceEnd: 500,
      prompt: { timelineCursor: { epoch, seq: 20 } },
    });
    owner.dispose();
  }
  async function verifyOccurrenceContinuation(mode: "stored" | "held-budget") {
    const owner = createCanonicalPromptContexts();
    const source = answer(500);
    const replacement = { ...source };
    acceptOccurrence(owner, source, 500);
    const held = deferred<ContextPage>();
    const started = deferred<void>();
    let start = 500;
    let cursor = 500;
    const readPage = vi.fn(
      async (
        input: Parameters<ReturnType<typeof rawPromptLookup>["readPage"]>[0],
      ): Promise<ContextPage> => {
        if (input.limit === 1) return occurrencePage([occurrenceEntry(source, start)], true);
        if (start === 400) return occurrencePage([occurrencePrompt(prior)]);
        cursor -= 1;
        if (mode === "held-budget" && cursor === 493) {
          started.resolve();
          return held.promise;
        }
        return occurrencePage([occurrenceEntry(answer(cursor), cursor)], true);
      },
    );
    const raw = { agentId, readPage, projection: "canonical" as const };
    const channel = {};
    const pending = request(owner, source, channel, raw);
    const rejected = expect(pending).rejects.toThrow(
      mode === "stored" ? "request budget" : "Reading context changed",
    );
    if (mode === "stored") await rejected;
    else await started.promise;
    expect(readPage).toHaveBeenCalledTimes(8);
    acceptOccurrence(owner, replacement, 400);
    if (mode === "held-budget") {
      held.resolve(occurrencePage([occurrenceEntry(answer(493), 493)], true));
      await rejected;
    }
    expect(owner.read(agentId, epoch, channel)).toEqual([]);
    await expect(request(owner, replacement, channel, raw)).rejects.toThrow(
      "Reading context changed",
    );
    expect(readPage).toHaveBeenCalledTimes(8);
    start = 400;
    await request(owner, replacement, channel, raw, 1);
    expect(readPage).toHaveBeenCalledTimes(10);
    expect(readPage.mock.calls[8]![0]).toEqual({
      epoch,
      cursor: 501,
      limit: 1,
      projection: "projected",
    });
    expect(owner.read(agentId, epoch, channel).at(-1)).toMatchObject({
      sourceStart: 400,
      prompt: { timelineCursor: { epoch, seq: 20 } },
    });
    owner.dispose();
  }

  it("rejects a held predecessor from a uniquely replaced source start with unchanged USER positions and requires a fresh explicit retry", async () => {
    await verifyHeldOccurrence("prompt");
  });

  it("reconciles the validated source start of held exhaustion before accepting an empty result", async () => {
    await verifyHeldOccurrence("exhausted");
  });

  it("discards a stored continuation whose source start conflicts with current unique metadata before resuming", async () => {
    await verifyOccurrenceContinuation("stored");
  });

  it("does not store budget progress after a held read crosses a unique source-start replacement", async () => {
    await verifyOccurrenceContinuation("held-budget");
  });

  it("settles a held source-start conflict from current local proof without changing USER positions or issuing another RPC", async () => {
    for (const outcome of ["prompt", "exhausted"]) {
      const owner = createCanonicalPromptContexts();
      const source = answer(500);
      const replacement = { ...source };
      const users = [prior, newer];
      acceptOccurrence(owner, source, 500, { users });
      expect(owner.preview(agentId, source)).toBeUndefined();
      const held = deferred<ContextPage>();
      const started = deferred<void>();
      const readPage = vi.fn(
        async (
          input: Parameters<ReturnType<typeof rawPromptLookup>["readPage"]>[0],
        ): Promise<ContextPage> => {
          if (input.limit === 1) return occurrencePage([occurrenceEntry(source, 500)], true);
          started.resolve();
          return held.promise;
        },
      );
      const channel = {};
      const pending = request(owner, source, channel, {
        agentId,
        readPage,
        projection: "projected",
      });
      await started.promise;
      acceptOccurrence(owner, replacement, 400, { users, complete: true });
      expect(owner.preview(agentId, replacement)?.prompt).toBe(prior);
      held.resolve(occurrencePage(outcome === "prompt" ? [occurrencePrompt(newer)] : []));
      await expect(pending).resolves.toBe(prior);
      const admitted = owner.read(agentId, epoch, channel).at(-1)!;
      expect(admitted).toMatchObject({ sourceStart: 400, sourceEnd: 500 });
      expect(admitted.prompt).toBe(prior);
      expect(owner.isSupportedContext(agentId, admitted)).toBe(true);
      expect(readPage).toHaveBeenCalledTimes(2);
      owner.dispose();
    }
  });

  it("treats render previews as read-only and rejects invalid originals, clones, forged derivatives and foreign certificates at admission", async () => {
    const source = answer(500);
    const target = answer(440);
    const owner = createCanonicalPromptContexts();
    const other = createCanonicalPromptContexts();
    accepted(owner, [target, source]);
    accepted(other, [target, source]);
    const seed = {};
    const raw = lookup(source);
    await request(owner, source, seed, raw);
    await request(other, source, {}, lookup(source));
    expect(raw.readPage).toHaveBeenCalledTimes(2);
    const original = owner.read(agentId, epoch, seed)[0]!;
    const foreign = other.read(agentId, epoch)[0]!;
    const before = owner.readRevision(agentId, epoch);
    const preview = owner.preview(agentId, target);
    expect(preview?.prompt.timelineCursor?.seq).toBe(20);
    expect(owner.isSupportedContext(agentId, preview!)).toBe(false);
    expect(owner.readRevision(agentId, epoch)).toBe(before);
    expect(owner.read(agentId, epoch, seed)).toEqual([original]);
    accepted(owner, [target, newer, source]);
    accepted(owner, [target, source]);
    const forged = {
      ...original,
      sourceKey: canonicalPromptSourceKey(target),
      sourceStart: 440,
      sourceEnd: 440,
    };
    const rogue = vi.fn(async () => original);
    for (const context of [original, { ...original }, preview!, forged, foreign]) {
      expect(owner.isSupportedContext(agentId, context)).toBe(false);
      const input = {
        agentId,
        source,
        channel: {},
        signal: new AbortController().signal,
        lookup: raw,
        lookupAllowed: false,
        retryToken: 0,
      };
      await expect(
        owner.request(Object.assign(input, { knownContext: context, fetchContext: rogue })),
      ).rejects.toThrow("Reading context changed");
    }
    expect(rogue).not.toHaveBeenCalled();
    expect(raw.readPage).toHaveBeenCalledTimes(2);
    expect(owner.preview(agentId, source)).toBeUndefined();
    await expect(
      owner.request({
        agentId,
        source,
        channel: {},
        signal: new AbortController().signal,
        lookup: { ...raw, agentId: "different-agent" },
        lookupAllowed: true,
        retryToken: 0,
      }),
    ).rejects.toThrow("different owner");
    expect(raw.readPage).toHaveBeenCalledTimes(2);
    const fresh = lookup(source, newer);
    await request(owner, source, {}, fresh, 1);
    expect(fresh.readPage).toHaveBeenCalledTimes(2);
    expect(owner.preview(agentId, source)?.prompt.timelineCursor?.seq).toBe(450);
    expect(owner.isSupportedContext(agentId, original)).toBe(false);
    expect(owner.read(agentId, epoch, seed)).toEqual([original]);
    owner.dispose();
    other.dispose();
  });

  it("retires held derivations after last-support release or four-slot eviction and blocks transport when preview support disappears", async () => {
    for (const mode of ["release", "eviction"]) {
      const owner = createCanonicalPromptContexts();
      const source = answer(500);
      const target = answer(440);
      const ordinary = Array.from({ length: 4 }, (_, index) => {
        const seq = 600 + index * 100;
        return {
          prompt: { ...prior, id: `P${seq}`, timelineCursor: { epoch, seq } },
          response: answer(seq + 10),
        };
      });
      const rows = [target, source, ...ordinary.flatMap((turn) => [turn.prompt, turn.response])];
      accepted(owner, rows);
      const seed = {};
      const raw = lookup(source);
      await request(owner, source, seed, raw);
      const original = owner.read(agentId, epoch, seed)[0]!;
      const heldPreview = owner.preview(agentId, target);
      expect(heldPreview?.prompt.timelineCursor?.seq).toBe(20);
      if (mode === "release") owner.release(seed);
      else {
        for (const turn of ordinary) await request(owner, turn.response, seed, undefined, 0, false);
        expect(owner.read(agentId, epoch, seed)).toHaveLength(4);
        expect(owner.read(agentId, epoch, seed).some((context) => context === original)).toBe(
          false,
        );
      }
      accepted(owner, [target, newer, ...rows.slice(1)]);
      accepted(owner, rows);
      expect(owner.isSupportedContext(agentId, original)).toBe(false);
      expect(owner.isSupportedContext(agentId, heldPreview!)).toBe(false);
      expect(owner.preview(agentId, target)).toBeUndefined();
      const input = {
        agentId,
        source: target,
        channel: {},
        lookup: raw,
        lookupAllowed: false,
        retryToken: 0,
        signal: new AbortController().signal,
      };
      await expect(
        owner.request(Object.assign(input, { knownContext: heldPreview })),
      ).rejects.toThrow("Reading context changed");
      expect(raw.readPage).toHaveBeenCalledTimes(2);
      owner.dispose();
    }
  });

  it("preserves another reader's support and commits same-lineage handoffs before reconciling the last support", async () => {
    const owner = createCanonicalPromptContexts();
    const source = answer(500);
    const targets = [answer(450), answer(440), answer(550), answer(460), answer(470)];
    accepted(owner, [source, ...targets]);
    const first = {};
    const second = {};
    const raw = lookup(source);
    await request(owner, source, first, raw);
    const original = owner.read(agentId, epoch, first)[0]!;
    await request(owner, source, second, raw, 0, false);
    owner.release(first);
    expect(owner.isSupportedContext(agentId, original)).toBe(true);
    owner.prepareSources(agentId, {
      ...certifiedReadingRows([source, ...targets]),
      cursor: {
        epoch,
        startSeq: 400,
        endSeq: 500,
        retainedRanges: [{ startSeq: 550, endSeq: 600 }],
      },
    });
    expect(owner.preview(agentId, targets[2]!)).toBeUndefined();
    expect(raw.readPage).toHaveBeenCalledTimes(2);
    accepted(owner, [source, ...targets]);
    for (const target of [...targets, targets[0]!, source]) {
      const preview = owner.preview(agentId, target);
      expect(preview?.prompt.timelineCursor?.seq).toBe(20);
      await request(owner, target, second, raw, 0, false);
      expect(owner.isSupportedContext(agentId, original)).toBe(true);
      expect(owner.read(agentId, epoch, second).length).toBeLessThanOrEqual(4);
    }
    expect(raw.readPage).toHaveBeenCalledTimes(2);
    owner.release(second);
    expect(owner.isSupportedContext(agentId, original)).toBe(false);
    expect(owner.preview(agentId, source)).toBeUndefined();
    owner.dispose();
  });

  it("fences a genuinely fresh held lookup across USER appearance and eviction without automatic retry or late enrollment", async () => {
    const owner = createCanonicalPromptContexts();
    const source = answer(500);
    accepted(owner, [source]);
    const held = deferred<ContextPage>();
    const raw = lookup(source);
    const readPage = vi.fn(raw.readPage).mockImplementationOnce(() => held.promise);
    const channel = {};
    const pending = request(owner, source, channel, { ...raw, readPage });
    const rejected = expect(pending).rejects.toThrow("Reading context changed");
    accepted(owner, [newer, source]);
    accepted(owner, [source]);
    const probe = await raw.readPage(
      { epoch, cursor: 501, limit: 1, projection: "projected" },
      new AbortController().signal,
    );
    held.resolve(probe);
    await rejected;
    expect(owner.read(agentId, epoch, channel)).toEqual([]);
    const calls = readPage.mock.calls.length;
    await expect(request(owner, source, channel, { ...raw, readPage })).rejects.toThrow(
      "Reading context changed",
    );
    expect(readPage).toHaveBeenCalledTimes(calls);
    await request(owner, source, channel, lookup(source, newer), 1);
    expect(owner.read(agentId, epoch, channel).at(-1)?.prompt.timelineCursor?.seq).toBe(450);
    owner.dispose();
  });

  it("binds continuations to the observed USER generation and requires explicit retry for a new lookup budget", async () => {
    const owner = createCanonicalPromptContexts();
    const source = answer(500);
    accepted(owner, [source]);
    const fixture = lookup(source);
    let cursor = 500;
    let completed = false;
    const readPage = vi.fn(
      async (
        input: Parameters<typeof fixture.readPage>[0],
        signal?: AbortSignal,
      ): Promise<ContextPage> => {
        if (input.limit === 1 || completed) return fixture.readPage(input, signal);
        cursor -= 1;
        return {
          epoch,
          hasOlder: true,
          error: null,
          reset: false,
          staleCursor: false,
          gap: false,
          entries: [
            {
              provider: "mock",
              timestamp: new Date(0).toISOString(),
              seqStart: cursor,
              seqEnd: cursor,
              sourceSeqRanges: [{ startSeq: cursor, endSeq: cursor }],
              collapsed: [],
              item: { type: "assistant_message", text: "Older answer" },
            },
          ],
        };
      },
    );
    const raw = { ...fixture, readPage };
    const channel = {};
    await expect(request(owner, source, channel, raw)).rejects.toThrow("request budget");
    expect(readPage).toHaveBeenCalledTimes(8);
    accepted(owner, [newer, source]);
    accepted(owner, [source]);
    await expect(request(owner, source, channel, raw)).rejects.toThrow("Reading context changed");
    expect(readPage).toHaveBeenCalledTimes(8);
    completed = true;
    await request(owner, source, channel, raw, 1);
    expect(readPage).toHaveBeenCalledTimes(10);
    expect(readPage.mock.calls[8]![0]).toEqual({
      epoch,
      cursor: 501,
      limit: 1,
      projection: "projected",
    });
    expect(owner.read(agentId, epoch, channel).at(-1)?.prompt.timelineCursor?.seq).toBe(20);
    owner.dispose();
  });

  it("does not invalidate a fresh held lookup for assistant streaming, array recreation or unchanged USER positions", async () => {
    const owner = createCanonicalPromptContexts();
    const source = answer(500);
    accepted(owner, [prior, source]);
    const held = deferred<ContextPage>();
    const raw = lookup(source);
    const readPage = vi
      .fn((...args: Parameters<typeof raw.readPage>) => raw.readPage(...args))
      .mockImplementationOnce(() => held.promise);
    const channel = {};
    const pending = request(owner, source, channel, { ...raw, readPage });
    for (let seq = 501; seq <= 505; seq += 1)
      accepted(owner, [
        { ...prior },
        { ...source, text: `stream ${seq}`, timelineCursor: { epoch, seq } },
      ]);
    const probe = await raw.readPage(
      { epoch, cursor: 501, limit: 1, projection: "projected" },
      new AbortController().signal,
    );
    held.resolve(probe);
    await expect(pending).resolves.toMatchObject(prior);
    expect(owner.read(agentId, epoch, channel).at(-1)?.sourceEnd).toBe(500);
    expect(readPage).toHaveBeenCalledTimes(2);
    owner.dispose();
  });

  it("settles a changed-generation lookup from valid current ordinary proof without another RPC", async () => {
    const owner = createCanonicalPromptContexts();
    const source = answer(500);
    accepted(owner, [source]);
    const held = deferred<ContextPage>();
    const raw = lookup(source);
    const readPage = vi
      .fn((...args: Parameters<typeof raw.readPage>) => raw.readPage(...args))
      .mockImplementationOnce(() => held.promise);
    const channel = {};
    const pending = request(owner, source, channel, { ...raw, readPage });
    accepted(owner, [newer, source], 450);
    const probe = await raw.readPage(
      { epoch, cursor: 501, limit: 1, projection: "projected" },
      new AbortController().signal,
    );
    held.resolve(probe);
    await expect(pending).resolves.toBe(newer);
    expect(readPage).toHaveBeenCalledTimes(1);
    const admitted = owner.read(agentId, epoch, channel).at(-1)!;
    expect(admitted.prompt).toBe(newer);
    expect(owner.isSupportedContext(agentId, admitted)).toBe(true);
    owner.dispose();
  });
});
