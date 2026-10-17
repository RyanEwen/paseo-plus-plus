import type { AgentTimelineCursorState } from "@/stores/session-store";
import type { StreamItem } from "@/types/stream";
import {
  canonicalPromptSourceKey,
  canonicalPromptOccurrenceKey,
  type CanonicalPromptContext,
  type CanonicalTimelineCoverage,
} from "./canonical-prompt-context";

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
  const covered = coverage.some(
    (range) =>
      range.epoch === position.epoch &&
      range.startSeq <= cursor.seq &&
      range.endSeq >= position.seq,
  );
  if (!covered) return undefined;
  return {
    sourceKey: canonicalPromptSourceKey(source),
    sourceStart,
    sourceEnd: position.seq,
    prompt,
  };
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

export function canonicalCoverageForCursor(
  cursor: AgentTimelineCursorState | null | undefined,
): readonly CanonicalTimelineCoverage[] {
  if (!cursor) return [];
  return [
    cursor,
    ...(cursor.retainedRanges ?? []).map((range) =>
      Object.assign({}, range, { epoch: cursor.epoch }),
    ),
  ];
}
