import {
  canonicalPromptSourceKey,
  CanonicalPromptContextBudgetError,
  type CanonicalPromptContextProgress,
  type CanonicalPromptContext,
} from "./canonical-prompt-model";
import {
  AgentTimelineListPromptsResponseMessageSchema,
  type AgentTimelineListPromptsResponseMessage,
  type FetchAgentTimelineResponseMessage,
} from "@getpaseo/protocol/messages";
import type { StreamItem } from "@/types/stream";
import { decodePromptEntry } from "./hydrate-prompt-entry";
import { TIMELINE_FETCH_PAGE_SIZE, PROMPT_DISCOVERY_PAGE_BUDGET } from "./timeline-fetch-policy";
type UserPrompt = Extract<StreamItem, { kind: "user_message" }>;

export type ContextPage = Pick<
  FetchAgentTimelineResponseMessage["payload"],
  "epoch" | "entries" | "hasOlder" | "error" | "reset" | "staleCursor" | "gap"
>;
export type ContextPageReader = (
  request: {
    epoch: string;
    cursor: number;
    limit: number;
    projection: "projected" | "canonical";
  },
  signal?: AbortSignal,
) => Promise<ContextPage>;
export type ContextEntry = ContextPage["entries"][number];

export interface ContextPromptIndexRequest {
  epoch: string;
  sourceStart: number;
}

/** Starts one complete index request after source proof, never a cached outline read. */
export type ContextPromptIndexReader = (
  request: ContextPromptIndexRequest,
  signal: AbortSignal,
) => Promise<AgentTimelineListPromptsResponseMessage["payload"]>;

export interface ContextPromptIndexLookup {
  agentId: string;
  readPromptIndex: ContextPromptIndexReader;
  /** Checks the owning channel, source and USER generation at every read boundary. */
  assertCurrent: () => void;
}

/** A source occurrence is its canonical position and kind, never messageId alone. */
export function contextSourceKey(source: StreamItem): string {
  return canonicalPromptSourceKey(source);
}

/** Read backward without applying a window. The source probe shares the eight-read budget.
 * Expanded projected entries may start before a page's owned cursor; actual source ranges
 * determine the next cursor. Ambiguous identity, nonprogress and budget exhaustion fail visibly.
 */
export async function fetchReadingPromptContext(
  reader: ContextPageReader,
  source: StreamItem,
  signal: AbortSignal,
  backwardProjection: "projected" | "canonical" = "canonical",
): Promise<UserPrompt | undefined> {
  return (await fetchCanonicalPromptContext(reader, source, signal, backwardProjection))?.prompt;
}

export async function fetchCanonicalPromptContext(
  reader: ContextPageReader,
  source: StreamItem,
  signal: AbortSignal,
  backwardProjection: "projected" | "canonical" = "canonical",
  progress?: CanonicalPromptContextProgress,
  resolveOrdinary?: (sourceStart: number) => UserPrompt | undefined,
  observeSourceStart?: (sourceStart: number) => void,
  indexedLookup?: ContextPromptIndexLookup,
): Promise<CanonicalPromptContext | null | undefined> {
  const position = source.timelineCursor;
  if (!position) throw new Error("Reading source has no canonical position");
  const read = async (cursor: number, limit: number, projection: "projected" | "canonical") => {
    if (signal.aborted) throw new Error("Reading context was cancelled");
    indexedLookup?.assertCurrent();
    const page = await reader({ epoch: position.epoch, cursor, limit, projection }, signal);
    indexedLookup?.assertCurrent();
    if (signal.aborted) throw new Error("Reading context was cancelled");
    if (page.epoch !== position.epoch || page.error || page.reset || page.staleCursor || page.gap)
      throw new Error("Reading context changed or is unavailable");
    for (const entry of page.entries) validateContextRange(entry);
    return page;
  };
  const sourceKey = contextSourceKey(source);
  validateContextContinuation(progress, sourceKey, position.seq);
  const acquired = await acquireContextSource(source, read, progress, indexedLookup !== undefined);
  const { probe, sourceStart } = acquired;
  let used = acquired.used;
  // Report only after the probe or continuation has passed the existing validator,
  // including exhausted reads which never produce a prompt context.
  observeSourceStart?.(sourceStart);
  const ordinary = resolveOrdinary?.(sourceStart);
  if (ordinary) return { sourceKey, sourceStart, sourceEnd: position.seq, prompt: ordinary };
  if (probe?.prompt) return decodeContext(probe.prompt, sourceKey, sourceStart, position);
  let cursor = progress?.cursor ?? sourceStart;
  if (indexedLookup) {
    const reserveRead = () => {
      if (used >= PROMPT_DISCOVERY_PAGE_BUDGET)
        throw new CanonicalPromptContextBudgetError({
          sourceKey,
          sourceStart,
          sourceEnd: position.seq,
          cursor,
        });
      used += 1;
    };
    const prompt = await readIndexedPredecessor({
      lookup: indexedLookup,
      request: { epoch: position.epoch, sourceStart },
      signal,
      read,
      projection: backwardProjection,
      reserveRead,
    });
    return prompt ? decodeContext(prompt, sourceKey, sourceStart, position) : undefined;
  }
  for (; used < PROMPT_DISCOVERY_PAGE_BUDGET; used += 1) {
    const page = await read(cursor, TIMELINE_FETCH_PAGE_SIZE, backwardProjection);
    const entries = page.entries;
    validateBackwardEntries(entries, cursor);
    const prompt = nearestPrecedingPrompt(entries, sourceStart);
    if (prompt) return decodeContext(prompt, sourceKey, sourceStart, position);
    if (!page.hasOlder) return undefined;
    const next = entries.length ? Math.min(...entries.map((entry) => entry.seqStart)) : cursor;
    if (next >= cursor) throw new Error("Reading context made no progress");
    cursor = next;
  }
  throw new CanonicalPromptContextBudgetError({
    sourceKey,
    sourceStart,
    sourceEnd: position.seq,
    cursor,
  });
}

/** null is a proven USER boundary without an ordinary body, not global exhaustion.
 * Stop here rather than assigning an older USER to this response. */
function decodeContext(
  entry: ContextEntry,
  sourceKey: string,
  sourceStart: number,
  position: { epoch: string; seq: number },
): CanonicalPromptContext | null {
  const prompt = decodePromptEntry(entry, position.epoch);
  return prompt ? { sourceKey, sourceStart, sourceEnd: position.seq, prompt } : null;
}

interface IndexedPredecessorRead {
  lookup: ContextPromptIndexLookup;
  request: ContextPromptIndexRequest;
  signal: AbortSignal;
  read: ReadContextPage;
  projection: "projected" | "canonical";
  reserveRead: () => void;
}

/** Validate the complete, current index before treating an empty predecessor set as exhaustion. */
function indexedPredecessor(
  payload: AgentTimelineListPromptsResponseMessage["payload"],
  agentId: string,
  request: ContextPromptIndexRequest,
): number | undefined {
  const parsed = AgentTimelineListPromptsResponseMessageSchema.shape.payload.safeParse(payload);
  if (
    !parsed.success ||
    parsed.data.agentId !== agentId ||
    parsed.data.epoch !== request.epoch ||
    parsed.data.error !== null
  )
    throw new Error("Reading prompt index changed or is unavailable");
  const seen = new Set<number>();
  let preceding: number | undefined;
  for (const prompt of parsed.data.prompts) {
    if (seen.has(prompt.seq)) throw new Error("Reading prompt index is ambiguous");
    seen.add(prompt.seq);
    if (prompt.seq < request.sourceStart && (preceding === undefined || prompt.seq > preceding))
      preceding = prompt.seq;
  }
  return preceding;
}

/** The index locates a USER, but only its exact canonical content proves a retained prompt. */
async function readIndexedPredecessor({
  lookup,
  request,
  signal,
  read,
  projection,
  reserveRead,
}: IndexedPredecessorRead): Promise<ContextEntry | undefined> {
  lookup.assertCurrent();
  reserveRead();
  const payload = await lookup.readPromptIndex(request, signal);
  lookup.assertCurrent();
  const seq = indexedPredecessor(payload, lookup.agentId, request);
  if (seq === undefined) return undefined;
  reserveRead();
  const page = await read(seq + 1, 1, projection);
  const prompt = page.entries[0];
  if (
    page.entries.length !== 1 ||
    !prompt ||
    prompt.item.type !== "user_message" ||
    prompt.seqStart !== seq ||
    prompt.seqEnd !== seq
  )
    throw new Error("Indexed prompt content changed or is unavailable");
  return prompt;
}

interface ContextSourceRead {
  probe: ProbedContextSource | undefined;
  sourceStart: number;
  used: number;
}

/** Indexed Retry reproves the source; raw fallback preserves its validated continuation. */
async function acquireContextSource(
  source: StreamItem,
  read: ReadContextPage,
  progress: CanonicalPromptContextProgress | undefined,
  indexed: boolean,
): Promise<ContextSourceRead> {
  const probe = progress && !indexed ? undefined : await probeContextSource(source, read);
  const sourceStart = probe?.entry.seqStart ?? progress!.sourceStart;
  if (progress && probe && progress.sourceStart !== sourceStart)
    throw new Error("Reading context source changed");
  return { probe, sourceStart, used: probe?.used ?? 0 };
}

interface ProbedContextSource {
  entry: ContextEntry;
  used: number;
  prompt: ContextEntry | undefined;
}

type ReadContextPage = (
  cursor: number,
  limit: number,
  projection: "projected" | "canonical",
) => Promise<ContextPage>;

/** Search display anchors, sharing the predecessor lookup's eight-read cap.
 * Lifecycle updates can move a row's seqEnd past newer rows without moving its
 * anchor. Every candidate still needs the exact source identity and actual range.
 */
async function probeContextSource(
  source: StreamItem,
  read: ReadContextPage,
): Promise<ProbedContextSource> {
  let cursor = source.timelineCursor!.seq + 1;
  for (let used = 0; used < PROMPT_DISCOVERY_PAGE_BUDGET; used += 1) {
    const limit = used === 0 ? 1 : TIMELINE_FETCH_PAGE_SIZE;
    const probe = await read(cursor, limit, "projected");
    validateBackwardEntries(probe.entries, cursor);
    const matches = probe.entries.filter((entry) => matchesContextSource(entry, source));
    if (matches.length > 1) throw new Error("Reading source occurrence is ambiguous");
    const entry = matches[0];
    if (entry)
      return {
        entry,
        used: used + 1,
        prompt: nearestPrecedingPrompt(probe.entries, entry.seqStart),
      };
    if (!probe.hasOlder || !probe.entries.length) break;
    cursor = Math.min(...probe.entries.map((candidate) => candidate.seqStart));
  }
  throw new Error("Reading source occurrence is unavailable");
}

/** Expanded payloads may extend past the cursor. Their display anchors must
 * still move backward; a future USER inside a source span is not its predecessor.
 */
function validateBackwardEntries(entries: readonly ContextEntry[], cursor: number): void {
  if (entries.some((entry) => entry.seqStart >= cursor))
    throw new Error("Reading context did not move backward");
}

function nearestPrecedingPrompt(
  entries: readonly ContextEntry[],
  sourceStart: number,
): ContextEntry | undefined {
  return entries
    .filter((entry) => entry.item.type === "user_message" && entry.seqEnd < sourceStart)
    .sort((a, b) => b.seqEnd - a.seqEnd)[0];
}

function validateContextContinuation(
  progress: CanonicalPromptContextProgress | undefined,
  sourceKey: string,
  sourceEnd: number,
): void {
  if (
    progress &&
    (progress.sourceKey !== sourceKey ||
      progress.sourceEnd !== sourceEnd ||
      !Number.isInteger(progress.sourceStart) ||
      !Number.isInteger(progress.cursor) ||
      progress.sourceStart < 0 ||
      progress.sourceStart > sourceEnd ||
      progress.cursor < 0 ||
      progress.cursor > progress.sourceStart)
  )
    throw new Error("Reading context continuation is invalid");
}

/** Validate real ranges instead of treating a legacy seqEnd as the source start. */
export function validateContextRange(entry: ContextEntry): void {
  if (
    !Number.isInteger(entry.seqStart) ||
    !Number.isInteger(entry.seqEnd) ||
    entry.seqStart < 0 ||
    entry.seqEnd < entry.seqStart ||
    !entry.sourceSeqRanges.length ||
    entry.sourceSeqRanges.some(
      (range) =>
        !Number.isInteger(range.startSeq) ||
        !Number.isInteger(range.endSeq) ||
        range.startSeq < entry.seqStart ||
        range.endSeq > entry.seqEnd ||
        range.endSeq < range.startSeq,
    ) ||
    Math.min(...entry.sourceSeqRanges.map((range) => range.startSeq)) !== entry.seqStart ||
    Math.max(...entry.sourceSeqRanges.map((range) => range.endSeq)) !== entry.seqEnd
  )
    throw new Error("Reading context has invalid canonical ranges");
}

/** Match the exact visible canonical occurrence, including turn and provider identity. */
export function matchesContextSource(entry: ContextEntry, source: StreamItem): boolean {
  const seq = source.timelineCursor?.seq;
  if (
    seq === undefined ||
    !entry.sourceSeqRanges.some((range) => range.startSeq <= seq && range.endSeq >= seq)
  )
    return false;
  let type: string = source.kind;
  if (source.kind === "thought") type = "reasoning";
  if (source.kind === "notification") type = source.sourceType;
  if (entry.item.type !== type) return false;
  if ("turnId" in source && source.turnId !== undefined && source.turnId !== entry.turnId)
    return false;
  if (source.kind === "assistant_message" && source.messageId !== undefined)
    return entry.item.type === "assistant_message" && entry.item.messageId === source.messageId;
  if (source.kind === "tool_call")
    return (
      source.payload.source === "agent" &&
      entry.item.type === "tool_call" &&
      entry.item.callId === source.payload.data.callId
    );
  return true;
}
