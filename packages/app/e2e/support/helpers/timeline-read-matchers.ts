import type { FetchAgentTimelineResponseMessage } from "@getpaseo/protocol/messages";

/** Stateless checks that a timeline response satisfies the read the ledger recorded. */

export interface ContentTarget {
  epoch: string;
  seq: number;
  projection: "projected" | "canonical";
  contextChainKey?: string;
}

/** Match a schema-valid response to the exact cached USER identity, never an overlapping range. */
export function matchesContentTarget(
  page: FetchAgentTimelineResponseMessage["payload"],
  target: ContentTarget,
  agentId: string,
) {
  if (
    page.agentId !== agentId ||
    page.direction !== "before" ||
    page.epoch !== target.epoch ||
    (page.projection !== "projected" && page.projection !== target.projection)
  )
    return false;
  if (page.error || page.reset || page.staleCursor || page.gap || page.mergeWindow === true)
    return false;
  if (page.entries.length !== 1) return false;
  const entry = page.entries[0]!;
  return (
    entry.item.type === "user_message" &&
    entry.seqStart === target.seq &&
    entry.seqEnd === target.seq &&
    matchesContentCursor(page.startCursor, target) &&
    matchesContentCursor(page.endCursor, target)
  );
}

/** Both returned bounds must name the expected prompt in its original epoch. */
function matchesContentCursor(
  cursor: FetchAgentTimelineResponseMessage["payload"]["startCursor"],
  target: ContentTarget,
) {
  return cursor?.epoch === target.epoch && cursor.seq === target.seq;
}

/** Source ranges must establish real bounds, including expanded projections crossing page bounds. */
function hasRealContextRanges(
  entry: FetchAgentTimelineResponseMessage["payload"]["entries"][number],
) {
  return (
    entry.sourceSeqRanges.length > 0 &&
    entry.seqStart <= entry.seqEnd &&
    entry.sourceSeqRanges.every(
      (range) =>
        range.startSeq >= entry.seqStart &&
        range.endSeq <= entry.seqEnd &&
        range.startSeq <= range.endSeq,
    ) &&
    Math.min(...entry.sourceSeqRanges.map((range) => range.startSeq)) === entry.seqStart &&
    Math.max(...entry.sourceSeqRanges.map((range) => range.endSeq)) === entry.seqEnd
  );
}

/** Validate schema-parsed response ownership before interpreting source ranges. */
export function matchesContextPage(
  page: FetchAgentTimelineResponseMessage["payload"],
  target: { epoch: string; cursor: number; probe: boolean },
  agentId: string,
) {
  return (
    page.agentId === agentId &&
    page.direction === "before" &&
    page.epoch === target.epoch &&
    // Published daemons honor canonical requests; current daemons return projected context.
    // Source probes always require the projected occurrence they requested.
    (page.projection === "projected" || (!target.probe && page.projection === "canonical")) &&
    !page.error &&
    !page.reset &&
    !page.staleCursor &&
    !page.gap &&
    page.mergeWindow !== true &&
    page.entries.every(hasRealContextRanges)
  );
}

/** Match expanded source spans and canonical occurrence identity, never just provider messageId. */
export function matchesProbeOccurrence(
  page: FetchAgentTimelineResponseMessage["payload"],
  source: FetchAgentTimelineResponseMessage["payload"]["entries"][number],
  target: { epoch: string; cursor: number },
) {
  const entry = page.entries[0];
  if (page.entries.length !== 1 || !entry) return false;
  if (
    entry.seqStart !== source.seqStart ||
    entry.seqEnd !== source.seqEnd ||
    JSON.stringify(entry.sourceSeqRanges) !== JSON.stringify(source.sourceSeqRanges) ||
    entry.item.type !== source.item.type ||
    entry.turnId !== source.turnId ||
    page.endCursor?.epoch !== target.epoch ||
    page.endCursor.seq !== target.cursor - 1
  )
    return false;
  if (
    "messageId" in source.item &&
    source.item.messageId !== ("messageId" in entry.item ? entry.item.messageId : undefined)
  )
    return false;
  if (
    "callId" in source.item &&
    source.item.callId !== ("callId" in entry.item ? entry.item.callId : undefined)
  )
    return false;
  return true;
}

/** Canonical pages own exactly their actual returned bounds, unlike expanded projected probes. */
export function matchesContextBounds(
  page: FetchAgentTimelineResponseMessage["payload"],
  target: { epoch: string; cursor: number },
) {
  if (!page.entries.length) return page.startCursor === null && page.endCursor === null;
  const start = Math.min(...page.entries.map((entry) => entry.seqStart));
  const end = Math.max(...page.entries.map((entry) => entry.seqEnd));
  return (
    page.startCursor?.epoch === target.epoch &&
    page.startCursor.seq === start &&
    page.endCursor?.epoch === target.epoch &&
    page.endCursor.seq === end
  );
}
