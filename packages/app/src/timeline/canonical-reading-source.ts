import type { StreamItem } from "@/types/stream";
import {
  resolveCanonicalSourceMetadata,
  hasCanonicalSourceEvidence,
  type CanonicalSourceMetadata,
} from "./canonical-source-metadata";
import {
  canonicalPromptSourceKey,
  canonicalPromptOccurrenceKey,
  type CanonicalPromptContext,
  type CanonicalTimelineCoverage,
} from "./canonical-prompt-model";

/** A source's true start comes from its validated canonical probe, never its
 * display row or seqEnd. Full ordinary coverage can then prove the nearest USER
 * without another backward request, including expanded/interleaved projections.
 */
export function resolveOrdinaryPromptContext(
  items: readonly StreamItem[],
  source: StreamItem,
  coverage: readonly CanonicalTimelineCoverage[],
  sourceStart: number,
): CanonicalPromptContext | undefined {
  const position = source.timelineCursor;
  if (!position || !Number.isInteger(sourceStart) || sourceStart < 0 || sourceStart > position.seq)
    return undefined;
  let prompt: Extract<StreamItem, { kind: "user_message" }> | undefined;
  for (const item of items) {
    if (
      item.kind !== "user_message" ||
      item.timelineCursor?.epoch !== position.epoch ||
      item.timelineCursor.seq >= sourceStart
    )
      continue;
    if (!prompt || item.timelineCursor.seq > prompt.timelineCursor!.seq) prompt = item;
  }
  if (!prompt) return undefined;
  const cursor = prompt.timelineCursor!;
  const covered = coversCanonicalInterval(coverage, position.epoch, cursor.seq, position.seq);
  if (!covered) return undefined;
  return {
    sourceKey: canonicalPromptSourceKey(source),
    sourceStart,
    sourceEnd: position.seq,
    prompt,
  };
}

export function coversCanonicalInterval(
  coverage: readonly CanonicalTimelineCoverage[],
  epoch: string,
  start: number,
  end: number,
): boolean {
  const ranges = coverage
    .filter((range) => range.epoch === epoch)
    .slice()
    .sort((a, b) => a.startSeq - b.startSeq);
  let next = start;
  for (const range of ranges) {
    if (range.endSeq < next) continue;
    if (range.startSeq > next) return false;
    if (range.endSeq >= end) return true;
    next = range.endSeq + 1;
  }
  return false;
}

interface KnownPromptContextInput {
  source: StreamItem;
  metadata: readonly CanonicalSourceMetadata[];
  items: readonly StreamItem[];
  coverage: readonly CanonicalTimelineCoverage[];
  contexts: readonly CanonicalPromptContext[];
  exactContext: CanonicalPromptContext | undefined;
}

/** Relationship reuse is distinct from exact occurrence caching. A proven
 * predecessor can cross loaded assistant rows only over certified coverage.
 * Contexts are current-owner admissions from validated lookup/local derivation,
 * never arbitrary prompt-shaped rows from a projection. */
export interface CanonicalPromptResolution {
  context: CanonicalPromptContext;
  parent: CanonicalPromptContext | undefined;
}

export function resolveKnownPromptContext(
  input: KnownPromptContextInput,
): CanonicalPromptContext | undefined {
  return resolveKnownPromptResolution(input)?.context;
}

export function resolveKnownPromptResolution(
  input: KnownPromptContextInput,
): CanonicalPromptResolution | undefined {
  const { source, metadata, items, coverage } = input;
  const cursor = source.timelineCursor;
  if (!cursor) return undefined;
  const descriptor = resolveCanonicalSourceMetadata(metadata, source);
  const exact = input.exactContext;
  // An ambiguous or changed ordinary revision cannot inherit older metadata.
  const conflicting = !descriptor && hasCanonicalSourceEvidence(metadata, source);
  if (conflicting) return undefined;
  const start = descriptor?.startSeq ?? exact?.sourceStart;
  if (start === undefined) return undefined;
  const ordinary = resolveOrdinaryPromptContext(items, source, coverage, start);
  if (ordinary) return { context: ordinary, parent: descriptor ? undefined : exact };
  if (exact && exact.sourceStart === start && !hasInterveningUser(exact, items)) {
    const current = withOrdinaryPromptRevision(exact, items);
    return { context: current, parent: exact };
  }
  return reuseRetainedPredecessor(input, start);
}

function reuseRetainedPredecessor(
  input: KnownPromptContextInput,
  start: number,
): CanonicalPromptResolution | undefined {
  const { source, contexts, items, coverage } = input;
  const cursor = source.timelineCursor!;
  for (const proof of contexts) {
    const promptCursor = proof.prompt.timelineCursor;
    if (
      !promptCursor ||
      promptCursor.epoch !== cursor.epoch ||
      promptCursor.seq >= start ||
      hasInterveningUser(proof, items)
    )
      continue;
    // The validated nearest-USER lookup certifies (prompt, sourceStart), so
    // moving backward uses a prefix of that certificate. Moving forward extends
    // it only over ordinary certified coverage; neither direction bridges a gap.
    if (!coversCanonicalInterval(coverage, cursor.epoch, start, cursor.seq)) continue;
    if (
      start > proof.sourceStart &&
      !coversCanonicalInterval(coverage, cursor.epoch, proof.sourceStart, start)
    )
      continue;
    const beforeSource = Math.max(proof.sourceStart, start);
    const intervening = items.some(
      (item) =>
        item.kind === "user_message" &&
        item.timelineCursor?.epoch === cursor.epoch &&
        item.timelineCursor.seq > promptCursor.seq &&
        item.timelineCursor.seq < beforeSource,
    );
    if (intervening) continue;
    const current = withOrdinaryPromptRevision(proof, items);
    const derived = {
      sourceKey: canonicalPromptSourceKey(source),
      sourceStart: start,
      sourceEnd: cursor.seq,
      prompt: current.prompt,
    };
    return { context: derived, parent: proof };
  }
  return undefined;
}

export function hasInterveningUser(
  proof: Pick<CanonicalPromptContext, "prompt" | "sourceStart">,
  items: readonly StreamItem[],
): boolean {
  const prompt = proof.prompt.timelineCursor;
  return (
    !!prompt &&
    items.some(
      (item) =>
        item.kind === "user_message" &&
        item.timelineCursor?.epoch === prompt.epoch &&
        item.timelineCursor.seq > prompt.seq &&
        item.timelineCursor.seq < proof.sourceStart,
    )
  );
}

function withOrdinaryPromptRevision(
  proof: CanonicalPromptContext,
  items: readonly StreamItem[],
): CanonicalPromptContext {
  const position = proof.prompt.timelineCursor;
  const ordinary = items.find(
    (item) =>
      item.kind === "user_message" &&
      position &&
      item.timelineCursor?.epoch === position.epoch &&
      item.timelineCursor.seq === position.seq,
  );
  return ordinary?.kind === "user_message" && ordinary !== proof.prompt
    ? { ...proof, prompt: ordinary }
    : proof;
}

/** An append is reusable only inside authoritative contiguous coverage with no
 * intervening USER, and with actual row/turn/provider identity and prefix intact.
 */
export function canCoalesceCanonicalSource(
  previous: StreamItem,
  next: StreamItem,
  items: readonly StreamItem[],
  coverage: readonly CanonicalTimelineCoverage[],
): boolean {
  const before = previous.timelineCursor;
  const after = next.timelineCursor;
  if (!before || !after || !sameCanonicalRow(previous, next) || after.seq < before.seq)
    return false;
  const covered = coverage.some(
    (range) =>
      range.epoch === before.epoch && range.startSeq <= before.seq && range.endSeq >= after.seq,
  );
  const interveningUser = items.some(
    (item) =>
      item.kind === "user_message" &&
      item.timelineCursor?.epoch === before.epoch &&
      item.timelineCursor.seq > before.seq &&
      item.timelineCursor.seq <= after.seq,
  );
  if (!covered || interveningUser) return false;
  return sourcePayloadAppended(previous, next);
}

function sameCanonicalRow(previous: StreamItem, next: StreamItem): boolean {
  return canonicalPromptOccurrenceKey(previous) === canonicalPromptOccurrenceKey(next);
}
function sourcePayloadAppended(previous: StreamItem, next: StreamItem): boolean {
  if (previous.kind === "assistant_message" && next.kind === "assistant_message")
    return previous.messageId === next.messageId && next.text.startsWith(previous.text);
  if (previous.kind === "thought" && next.kind === "thought")
    return next.text.startsWith(previous.text);
  if (previous.kind === "tool_call" && next.kind === "tool_call")
    return (
      previous.payload.source === "agent" &&
      next.payload.source === "agent" &&
      previous.payload.data.callId === next.payload.data.callId
    );
  return false;
}

export interface CanonicalReadingAttempt {
  anchor: StreamItem | undefined;
  latest: StreamItem | undefined;
  blocked: boolean;
  attempt: number;
}
/** Advancing an unproved same-row cursor cannot buy another automatic request
 * budget. Retry deliberately starts from the latest position instead.
 */
export function planCanonicalReadingAttempt(
  previous: CanonicalReadingAttempt | undefined,
  source: StreamItem | undefined,
  items: readonly StreamItem[],
  coverage: readonly CanonicalTimelineCoverage[],
  attempt: number,
): CanonicalReadingAttempt {
  const fresh = { anchor: source, latest: source, blocked: false, attempt };
  if (!previous?.latest || !previous.anchor || !source || previous.attempt !== attempt)
    return fresh;
  const before = previous.latest;
  const sameRow = sameCanonicalRow(before, source);
  if (!sameRow) return fresh;
  const unchanged = canonicalPromptSourceKey(before) === canonicalPromptSourceKey(source);
  if (unchanged) return { ...previous, latest: source };
  if (canCoalesceCanonicalSource(before, source, items, coverage) && !previous.blocked)
    return { ...previous, latest: source };
  return { ...previous, latest: source, blocked: true };
}

interface CoverageCursor extends CanonicalTimelineCoverage {
  retainedRanges?: readonly Pick<CanonicalTimelineCoverage, "startSeq" | "endSeq">[];
}

export function canonicalCoverageForCursor(
  cursor: CoverageCursor | null | undefined,
): readonly CanonicalTimelineCoverage[] {
  if (!cursor) return [];
  return [
    cursor,
    ...(cursor.retainedRanges ?? []).map((range) =>
      Object.assign({}, range, { epoch: cursor.epoch }),
    ),
  ];
}
