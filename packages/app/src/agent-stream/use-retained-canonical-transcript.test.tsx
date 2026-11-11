// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { createPromptReadingPublisher } from "./prompt-reading-position";
import { useRetainedCanonicalTranscript } from "./use-retained-canonical-transcript";

function row(kind: "user_message" | "assistant_message", id: string, seq: number): StreamItem {
  return {
    kind,
    id,
    text: id,
    timestamp: new Date(0),
    timelineCursor: { epoch: "e", seq },
  } as StreamItem;
}

const TAIL = [row("user_message", "user", 1), row("assistant_message", "answer", 2)];
const PUBLISHER = createPromptReadingPublisher();

function transcriptInput(stickyEnabled: boolean, effectiveStreamHead: StreamItem[]) {
  return {
    resolvedServerId: "server",
    agentId: "agent",
    timelineEpoch: "e",
    historyPagination: undefined,
    rootTimelineCursor: undefined,
    client: null,
    promptReading: PUBLISHER,
    effectiveStreamItems: TAIL,
    effectiveStreamHead,
    stickyEnabled,
    canIndexPrompts: false,
    isActive: true,
    isAuthoritativeHistoryReady: true,
  };
}

const firstHead = [row("assistant_message", "live", 3)];
const nextHead = [row("assistant_message", "live", 3)];

describe("useRetainedCanonicalTranscript", () => {
  it("keeps prompt rows and the canonical tail across stream ticks", () => {
    const { result, rerender } = renderHook(useRetainedCanonicalTranscript, {
      initialProps: transcriptInput(true, firstHead),
    });
    const { promptRows, canonicalTail, contextOnlyIds } = result.current;

    rerender(transcriptInput(true, nextHead));

    expect(result.current.promptRows).toBe(promptRows);
    expect(result.current.canonicalTail).toBe(canonicalTail);
    expect(result.current.contextOnlyIds).toBe(contextOnlyIds);
    expect(result.current.navigationItems).toEqual([...TAIL, ...nextHead]);
  });

  it("includes a user row in the streaming head", () => {
    const head = [row("user_message", "submitted", 3)];
    const { result } = renderHook(useRetainedCanonicalTranscript, {
      initialProps: transcriptInput(true, head),
    });

    expect(result.current.promptRows).toEqual([...TAIL, ...head]);
  });

  it("derives no navigation rows while the feature is off", () => {
    const { result } = renderHook(useRetainedCanonicalTranscript, {
      initialProps: transcriptInput(false, firstHead),
    });

    expect(result.current.navigationItems).toEqual([]);
    expect(result.current.promptRows).toEqual([]);
    expect(result.current.sourceItems).toEqual([...TAIL, ...firstHead]);
  });
});
