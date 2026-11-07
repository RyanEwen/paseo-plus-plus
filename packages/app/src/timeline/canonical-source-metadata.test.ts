import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import {
  EMPTY_SOURCE_METADATA,
  hasCanonicalSourceEvidence,
  reconcileCanonicalSourceMetadata,
  resolveCanonicalSourceMetadata,
  type AcceptedCanonicalSources,
  type CanonicalSourceEntry,
} from "./canonical-source-metadata";

function answer(seq: number, text = "Answer"): StreamItem {
  return {
    kind: "assistant_message",
    id: `answer-${seq}`,
    messageId: "message",
    text,
    timestamp: new Date(0),
    timelineCursor: { epoch: "e", seq },
  };
}

function projectedEntry(seq: number, text = "Answer"): CanonicalSourceEntry {
  return {
    seqStart: seq,
    seqEnd: seq,
    provider: "mock",
    item: { type: "assistant_message", text, messageId: "message" },
  };
}

function accepted(
  row: StreamItem,
  entries: readonly CanonicalSourceEntry[],
  overrides: Partial<AcceptedCanonicalSources> = {},
): AcceptedCanonicalSources {
  return {
    projection: "projected",
    epoch: "e",
    entries,
    tail: [row],
    head: [],
    cursor: { epoch: "e", startSeq: 1, endSeq: 10 },
    ...overrides,
  };
}

describe("reconcileCanonicalSourceMetadata", () => {
  it("certifies a projected entry's source range for its ordinary row", () => {
    const row = answer(4);
    const metadata = reconcileCanonicalSourceMetadata(
      EMPTY_SOURCE_METADATA,
      accepted(row, [projectedEntry(4)]),
    );

    expect(resolveCanonicalSourceMetadata(metadata, row)).toMatchObject({
      epoch: "e",
      startSeq: 4,
      endSeq: 4,
    });
  });

  it("keeps nothing without a cursor in the accepted epoch", () => {
    const row = answer(4);

    expect(
      reconcileCanonicalSourceMetadata(
        EMPTY_SOURCE_METADATA,
        accepted(row, [projectedEntry(4)], { cursor: null }),
      ),
    ).toBe(EMPTY_SOURCE_METADATA);
  });

  it("does not certify rows from canonical delta pages", () => {
    const row = answer(4);
    const metadata = reconcileCanonicalSourceMetadata(
      EMPTY_SOURCE_METADATA,
      accepted(row, [projectedEntry(4)], { projection: "canonical" }),
    );

    expect(resolveCanonicalSourceMetadata(metadata, row)).toBeUndefined();
  });

  it("rejects an entry whose body does not match the ordinary row", () => {
    const row = answer(4, "Answer");
    const metadata = reconcileCanonicalSourceMetadata(
      EMPTY_SOURCE_METADATA,
      accepted(row, [projectedEntry(4, "Different")]),
    );

    expect(resolveCanonicalSourceMetadata(metadata, row)).toBeUndefined();
  });

  it("treats competing descriptors for one row as evidence that needs a real probe", () => {
    const row = answer(4);
    const first = reconcileCanonicalSourceMetadata(
      EMPTY_SOURCE_METADATA,
      accepted(row, [projectedEntry(4)]),
    );
    const rival: CanonicalSourceEntry = {
      ...projectedEntry(4),
      seqStart: 3,
      sourceSeqRanges: [
        { startSeq: 3, endSeq: 3 },
        { startSeq: 4, endSeq: 4 },
      ],
    };
    const competing = reconcileCanonicalSourceMetadata(first, accepted(row, [rival]));

    expect(resolveCanonicalSourceMetadata(competing, row)).toBeUndefined();
    expect(hasCanonicalSourceEvidence(competing, row)).toBe(true);
  });
});
