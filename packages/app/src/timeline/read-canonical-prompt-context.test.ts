import { describe, expect, it, vi } from "vitest";
import type { StreamItem } from "@/types/stream";
import {
  fetchReadingPromptContext,
  ReadingContextError,
  validateContextRange,
  type ContextEntry,
  type ContextPageReader,
} from "./read-canonical-prompt-context";

function entry(ranges: ContextEntry["sourceSeqRanges"], seqStart = 2, seqEnd = 5): ContextEntry {
  return {
    item: { type: "assistant_message", text: "Answer" },
    timestamp: "2026-10-12T00:00:00.000Z",
    provider: "mock",
    seqStart,
    seqEnd,
    sourceSeqRanges: ranges,
    collapsed: [],
  } as ContextEntry;
}

const SOURCE: StreamItem = {
  kind: "assistant_message",
  id: "answer",
  text: "Answer",
  timestamp: new Date(0),
  timelineCursor: { epoch: "e", seq: 5 },
};

describe("validateContextRange", () => {
  it("accepts source ranges that start and end at the entry's bounds", () => {
    expect(() =>
      validateContextRange(
        entry([
          { startSeq: 2, endSeq: 2 },
          { startSeq: 4, endSeq: 5 },
        ]),
      ),
    ).not.toThrow();
  });

  it.each([
    ["no source ranges", entry([])],
    ["a range past the entry's end", entry([{ startSeq: 2, endSeq: 6 }])],
    ["ranges that do not reach the entry's start", entry([{ startSeq: 3, endSeq: 5 }])],
    ["a reversed entry", entry([{ startSeq: 2, endSeq: 5 }], 5, 2)],
  ])("rejects %s as invalid canonical ranges", (_label, invalid) => {
    expect(() => validateContextRange(invalid)).toThrow(
      expect.objectContaining({ reason: "invalid-ranges" }),
    );
  });
});

describe("fetchReadingPromptContext", () => {
  it("fails a source without a canonical position before reading", async () => {
    const reader: ContextPageReader = vi.fn();
    const unpositioned: StreamItem = { ...SOURCE, timelineCursor: undefined };

    await expect(
      fetchReadingPromptContext(reader, unpositioned, new AbortController().signal),
    ).rejects.toThrow(expect.objectContaining({ reason: "no-position" }));
    expect(reader).not.toHaveBeenCalled();
  });

  it("makes no read once its signal is cancelled", async () => {
    const reader: ContextPageReader = vi.fn();
    const controller = new AbortController();
    controller.abort();

    await expect(fetchReadingPromptContext(reader, SOURCE, controller.signal)).rejects.toThrow(
      ReadingContextError,
    );
    expect(reader).not.toHaveBeenCalled();
  });
});
