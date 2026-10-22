import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { StreamItem } from "@/types/stream";

interface SourceRange {
  startSeq: number;
  endSeq: number;
}
export interface CanonicalSourceEntry {
  seqStart: number;
  seqEnd: number;
  sourceSeqRanges?: readonly SourceRange[];
  provider: string;
  turnId?: string;
  item: AgentTimelineItem;
}
export interface CanonicalSourceMetadata {
  epoch: string;
  provider: string;
  type: AgentTimelineItem["type"];
  turnId: string | undefined;
  messageId: string | undefined;
  callId: string | undefined;
  startSeq: number;
  endSeq: number;
  ranges: readonly SourceRange[];
  /** Reference to the ordinary revision, not another hydrated copy. A live
   * replacement invalidates its proof until authoritative ranges arrive. */
  revision: StreamItem;
}
export interface AcceptedCanonicalSources {
  projection: "projected" | "canonical";
  epoch: string;
  entries: readonly CanonicalSourceEntry[];
  tail: readonly StreamItem[];
  head: readonly StreamItem[];
  cursor:
    | ({ epoch: string; retainedRanges?: readonly SourceRange[] } & SourceRange)
    | null
    | undefined;
}
export const EMPTY_SOURCE_METADATA: readonly CanonicalSourceMetadata[] = Object.freeze([]);
// Overflow loses only an optimization. It cannot change the ordinary window or
// manufacture source coverage; an omitted descriptor requires a real probe.
const MAX_SOURCE_DESCRIPTORS = 256;
const MAX_SOURCE_RANGES = 64;
interface UnresolvedSourceRevisions {
  revisions: WeakSet<StreamItem>;
  count: number;
}
// The immutable collection owns its ambiguity evidence. Weak keys neither keep
// evicted ordinary rows alive nor leak one owner's evidence into another owner.
const unresolvedSources = new WeakMap<
  readonly CanonicalSourceMetadata[],
  UnresolvedSourceRevisions
>();

export function hasCanonicalSourceEvidence(
  metadata: readonly CanonicalSourceMetadata[],
  source: StreamItem,
): boolean {
  return (
    unresolvedSources.get(metadata)?.revisions.has(source) === true ||
    metadata.some((entry) => entry.revision === source)
  );
}

function boundSourceMetadata(
  previous: readonly CanonicalSourceMetadata[],
  candidates: readonly CanonicalSourceMetadata[],
  ordinary: ReadonlySet<StreamItem>,
): readonly CanonicalSourceMetadata[] {
  const previousUnresolved = unresolvedSources.get(previous);
  const invalid = new Set(
    Array.from(ordinary).filter((row) => previousUnresolved?.revisions.has(row)),
  );
  const unique = new Map<StreamItem, CanonicalSourceMetadata>();
  for (const candidate of candidates) {
    if (unique.has(candidate.revision)) invalid.add(candidate.revision);
    else unique.set(candidate.revision, candidate);
  }
  // Group before bounding: a truncated rival must never turn its surviving
  // partner into unique proof. Even an entirely evicted group blocks cache reuse.
  const valid = Array.from(unique.values()).filter((entry) => !invalid.has(entry.revision));
  const next = valid.slice(-MAX_SOURCE_DESCRIPTORS);
  const sameInvalid =
    invalid.size === (previousUnresolved?.count ?? 0) &&
    Array.from(invalid).every((row) => previousUnresolved?.revisions.has(row));
  if (
    sameInvalid &&
    next.length === previous.length &&
    next.every((entry, index) => entry === previous[index])
  )
    return previous;
  if (!next.length && !invalid.size) return EMPTY_SOURCE_METADATA;
  const snapshot = Object.freeze(next);
  if (invalid.size)
    unresolvedSources.set(snapshot, { revisions: new WeakSet(invalid), count: invalid.size });
  return snapshot;
}

function certifiedRanges(entry: CanonicalSourceEntry): readonly SourceRange[] | undefined {
  const sourceRanges =
    entry.sourceSeqRanges ??
    (entry.seqStart === entry.seqEnd ? [{ startSeq: entry.seqStart, endSeq: entry.seqEnd }] : []);
  const ranges = [...sourceRanges].sort((left, right) => left.startSeq - right.startSeq);
  if (!ranges.length || ranges.length > MAX_SOURCE_RANGES) return undefined;
  let previous = entry.seqStart - 1;
  for (const range of ranges) {
    if (
      !Number.isInteger(range.startSeq) ||
      !Number.isInteger(range.endSeq) ||
      range.startSeq <= previous ||
      range.endSeq < range.startSeq ||
      range.endSeq > entry.seqEnd
    )
      return undefined;
    previous = range.endSeq;
  }
  if (
    !Number.isInteger(entry.seqStart) ||
    entry.seqStart < 0 ||
    ranges[0]!.startSeq !== entry.seqStart ||
    previous !== entry.seqEnd
  )
    return undefined;
  return Object.freeze(ranges.map((range) => Object.freeze({ ...range })));
}

function sourceType(source: StreamItem): string {
  if (source.kind === "thought") return "reasoning";
  if (source.kind === "notification") return source.sourceType;
  return source.kind;
}

function matchesSourceIdentity(metadata: CanonicalSourceMetadata, source: StreamItem): boolean {
  if (metadata.revision !== source || metadata.type !== sourceType(source)) return false;
  const turnId = "turnId" in source ? source.turnId : undefined;
  if (turnId !== metadata.turnId) return false;
  if (source.kind === "assistant_message") return source.messageId === metadata.messageId;
  if (source.kind === "tool_call")
    return (
      source.payload.source === "agent" &&
      source.payload.data.provider === metadata.provider &&
      source.payload.data.callId === metadata.callId
    );
  return true;
}

function describeSource(
  entry: CanonicalSourceEntry,
  epoch: string,
  revision: StreamItem,
  ranges: readonly SourceRange[],
): CanonicalSourceMetadata | undefined {
  const metadata: CanonicalSourceMetadata = Object.freeze({
    epoch,
    provider: entry.provider,
    type: entry.item.type,
    turnId: entry.turnId,
    messageId: entry.item.type === "assistant_message" ? entry.item.messageId : undefined,
    callId: entry.item.type === "tool_call" ? entry.item.callId : undefined,
    startSeq: entry.seqStart,
    endSeq: entry.seqEnd,
    ranges,
    revision,
  });
  return matchesSourceIdentity(metadata, revision) && matchesProjectedBody(entry, revision)
    ? metadata
    : undefined;
}

function matchesProjectedBody(entry: CanonicalSourceEntry, source: StreamItem): boolean {
  if (source.kind === "assistant_message")
    return entry.item.type === "assistant_message" && entry.item.text === source.text;
  if (source.kind === "thought")
    return entry.item.type === "reasoning" && entry.item.text === source.text;
  return source.kind === "tool_call";
}

function sameSourceDescriptor(
  left: CanonicalSourceMetadata,
  right: CanonicalSourceMetadata,
): boolean {
  const identity = (entry: CanonicalSourceMetadata) =>
    JSON.stringify([
      entry.epoch,
      entry.provider,
      entry.type,
      entry.turnId,
      entry.messageId,
      entry.callId,
      entry.startSeq,
      entry.endSeq,
      entry.ranges.map((range) => [range.startSeq, range.endSeq]),
    ]);
  return identity(left) === identity(right);
}

/** Called only for the reducer's actually accepted units, before its rows become
 * observable. Retention is bounded by the resulting ordinary rows and coverage. */
export function reconcileCanonicalSourceMetadata(
  previous: readonly CanonicalSourceMetadata[],
  input: AcceptedCanonicalSources,
): readonly CanonicalSourceMetadata[] {
  const rows = [...input.tail, ...input.head];
  const cursor = input.cursor;
  if (!cursor || cursor.epoch !== input.epoch) return EMPTY_SOURCE_METADATA;
  const coverage = [cursor, ...(cursor.retainedRanges ?? [])];
  const ordinary = new Set(rows);
  const retained = previous.filter(
    (entry) =>
      entry.epoch === input.epoch &&
      ordinary.has(entry.revision) &&
      coverage.some((range) => range.startSeq <= entry.endSeq && range.endSeq >= entry.endSeq),
  );
  const additions: CanonicalSourceMetadata[] = [];
  // Canonical delta pages may assemble several units into one row. Only the
  // projected journal entry certifies that assembled row's actual first source.
  const projected = input.projection === "projected" ? input.entries : [];
  for (const entry of projected) {
    const ranges = certifiedRanges(entry);
    if (!ranges) continue;
    const candidates = rows.filter(
      (row) =>
        row.timelineCursor?.epoch === input.epoch &&
        ranges.some(
          (range) =>
            range.startSeq <= row.timelineCursor!.seq && range.endSeq >= row.timelineCursor!.seq,
        ),
    );
    for (const row of candidates) {
      const metadata = describeSource(entry, input.epoch, row, ranges);
      if (
        metadata &&
        coverage.some(
          (range) => range.startSeq <= metadata.endSeq && range.endSeq >= metadata.endSeq,
        )
      )
        additions.push(metadata);
    }
  }
  // Re-observing identical proof is idempotent. A different descriptor for the
  // same ordinary revision must compete with prior evidence, not replace it.
  const observed = additions.map(
    (entry) =>
      retained.find((old) => old.revision === entry.revision && sameSourceDescriptor(old, entry)) ??
      entry,
  );
  const candidates = [...retained.filter((entry) => !observed.includes(entry)), ...observed];
  return boundSourceMetadata(previous, candidates, ordinary);
}

/** A hole inside an expanded source is not an occurrence of that source. Two
 * competing projected occurrences at the same cursor require a real probe. */
export function resolveCanonicalSourceMetadata(
  metadata: readonly CanonicalSourceMetadata[],
  source: StreamItem,
): CanonicalSourceMetadata | undefined {
  const cursor = source.timelineCursor;
  if (!cursor || unresolvedSources.get(metadata)?.revisions.has(source)) return undefined;
  const matches = metadata.filter(
    (entry) =>
      entry.epoch === cursor.epoch &&
      matchesSourceIdentity(entry, source) &&
      entry.ranges.some((range) => range.startSeq <= cursor.seq && range.endSeq >= cursor.seq),
  );
  return matches.length === 1 ? matches[0] : undefined;
}
