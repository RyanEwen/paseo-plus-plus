import { bench, describe } from "vitest";
import {
  mergeRetainedPrompts,
  retainedCanonicalPositions,
} from "@/timeline/canonical-prompt-context";
import { retainBounded } from "@/timeline/canonical-prompt-model";
import type { StreamItem } from "@/types/stream";
import type { ChatOutlinePrompt } from "./chat-outline/model";
import {
  buildPromptTargets,
  indexContextSources,
  NO_PROMPT_ROWS,
  resolveIndexedContextSource,
  resolveReadingPromptTarget,
  resolveRetainedContextSource,
  selectPromptHead,
  type UserPrompt,
} from "./sticky-prompt-model";

// The sticky prompt work one streamed delta costs on a long timeline, without React:
//   npx vitest bench --project unit src/agent-stream/sticky-prompt-tick.bench.ts

const EPOCH = "epoch";
const TIMELINE_ITEMS = 2_000;
const TICKS = 200;
const COVERAGE = [{ epoch: EPOCH, startSeq: 0, endSeq: TIMELINE_ITEMS }];
const READING = { navigating: false, following: false, rowId: "row-1001", seq: 1001 };
const MAX_CACHED_PROMPTS = 16;

function row(seq: number): StreamItem {
  const base = {
    id: `row-${seq}`,
    text: "text",
    timestamp: new Date(seq),
    timelineCursor: { epoch: EPOCH, seq },
  };
  return seq % 4 === 0 ? { ...base, kind: "user_message" } : { ...base, kind: "assistant_message" };
}

const tail = Array.from({ length: TIMELINE_ITEMS }, (_unused, seq) => row(seq));
const prompts: ChatOutlinePrompt[] = tail.flatMap((item) =>
  item.kind === "user_message"
    ? [{ seq: item.timelineCursor!.seq, timestamp: "", preview: "" }]
    : [],
);
const heads = Array.from({ length: TICKS }, (_unused, tick): StreamItem[] => [
  {
    kind: "assistant_message",
    id: "live",
    text: "token ".repeat(tick),
    timestamp: new Date(TIMELINE_ITEMS),
  },
]);

function isUserPrompt(item: StreamItem): item is UserPrompt {
  return item.kind === "user_message";
}

function cacheKnownPrompts(rows: readonly StreamItem[]): void {
  const cache = new Map<string, UserPrompt>();
  for (const item of rows.filter(isUserPrompt))
    retainBounded(cache, `prompt:${item.timelineCursor!.seq}`, item, MAX_CACHED_PROMPTS);
}

/** Every derivation rebuilt per delta, as when each memo depended on the head. */
function rebuildPerDelta(head: StreamItem[]): void {
  const sourceItems = [...tail, ...head];
  resolveRetainedContextSource(sourceItems, EPOCH, READING, COVERAGE);
  const canonicalTail = mergeRetainedPrompts(tail, [], head);
  retainedCanonicalPositions(canonicalTail, []);
  const contextOnly = new Set(mergeRetainedPrompts([], [], sourceItems).map((item) => item.id));
  const items = canonicalTail.concat(head);
  const targets = buildPromptTargets(items, prompts, EPOCH, contextOnly);
  resolveReadingPromptTarget(items, targets, READING.rowId, READING.seq);
  cacheKnownPrompts(items);
}

/** What still runs per delta once tail-derived work is memoized on the tail. */
function createMemoizedDelta() {
  const index = indexContextSources(tail, EPOCH);
  const canonicalTail = mergeRetainedPrompts(tail, [], NO_PROMPT_ROWS);
  retainedCanonicalPositions(canonicalTail, []);
  const targets = buildPromptTargets(canonicalTail, prompts, EPOCH, new Set());
  cacheKnownPrompts(canonicalTail);
  return (head: StreamItem[]) => {
    const sourceItems = [...tail, ...head];
    resolveIndexedContextSource({
      index,
      items: sourceItems,
      head,
      epoch: EPOCH,
      reading: READING,
      coverage: COVERAGE,
    });
    selectPromptHead(head);
    const items = canonicalTail.concat(head);
    resolveReadingPromptTarget(items, targets, READING.rowId, READING.seq);
  };
}

describe(`sticky prompt work for ${TICKS} deltas over ${TIMELINE_ITEMS} items`, () => {
  bench("rebuilt on every delta", () => {
    for (const head of heads) rebuildPerDelta(head);
  });

  const memoizedDelta = createMemoizedDelta();
  bench("memoized on the tail", () => {
    for (const head of heads) memoizedDelta(head);
  });
});
