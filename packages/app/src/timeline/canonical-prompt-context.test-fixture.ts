import type { StreamItem } from "@/types/stream";
import type {
  CanonicalPromptContext,
  CanonicalPromptContextProgress,
} from "./canonical-prompt-model";
import type { CanonicalPromptContexts, CanonicalPromptLookup } from "./canonical-prompt-context";
import type { ContextPage } from "./read-canonical-prompt-context";

type FixtureReader = (
  source: StreamItem,
  signal: AbortSignal,
  progress?: CanonicalPromptContextProgress,
) => Promise<CanonicalPromptContext | undefined>;
const lookups = new WeakMap<
  FixtureReader,
  WeakMap<StreamItem, Map<string, CanonicalPromptLookup>>
>();

/** Convert existing fixture values into raw canonical pages. The production
 * owner still runs the real probe/range/identity/backward-page validator. */
export function rawPromptLookup(
  source: StreamItem,
  readFixture: FixtureReader,
  agentId = "agent",
): CanonicalPromptLookup {
  let bySource = lookups.get(readFixture);
  if (!bySource) {
    bySource = new WeakMap();
    lookups.set(readFixture, bySource);
  }
  let byAgent = bySource.get(source);
  if (!byAgent) {
    byAgent = new Map();
    bySource.set(source, byAgent);
  }
  const previous = byAgent.get(agentId);
  if (previous) return previous;
  let pending: CanonicalPromptContext | undefined;
  const lookup: CanonicalPromptLookup = {
    agentId,
    projection: "canonical",
    async readPage(request, signal) {
      if (source.kind !== "assistant_message") throw new Error("Expected an assistant fixture");
      if (!signal) throw new Error("Expected owner lookup cancellation signal");
      const page: ContextPage = {
        epoch: request.epoch,
        entries: [],
        hasOlder: false,
        error: null,
        reset: false,
        staleCursor: false,
        gap: false,
      };
      if (request.limit === 1) {
        const current = {
          ...source,
          timelineCursor: { epoch: request.epoch, seq: request.cursor - 1 },
        };
        pending = await readFixture(current, signal);
        const start = pending?.sourceStart ?? current.timelineCursor.seq;
        return {
          ...page,
          hasOlder: true,
          entries: [
            {
              provider: "mock",
              turnId: current.turnId,
              timestamp: current.timestamp.toISOString(),
              seqStart: start,
              seqEnd: current.timelineCursor.seq,
              sourceSeqRanges: [{ startSeq: start, endSeq: current.timelineCursor.seq }],
              collapsed: [],
              item: { type: "assistant_message", messageId: current.messageId, text: current.text },
            },
          ],
        };
      }
      if (!pending) return page;
      const prompt = pending.prompt;
      const seq = prompt.timelineCursor!.seq;
      return {
        ...page,
        entries: [
          {
            provider: "mock",
            timestamp: prompt.timestamp.toISOString(),
            seqStart: seq,
            seqEnd: seq,
            sourceSeqRanges: [{ startSeq: seq, endSeq: seq }],
            collapsed: [],
            item: {
              type: "user_message",
              messageId: prompt.messageId ?? prompt.id,
              text: prompt.text,
            },
          },
        ],
      };
    },
  };
  byAgent.set(agentId, lookup);
  return lookup;
}

interface PromptRequestFixture {
  agentId: string;
  source: StreamItem;
  channel: object;
  signal: AbortSignal;
  fetchContext(
    source: StreamItem,
    signal: AbortSignal,
    progress?: CanonicalPromptContextProgress,
  ): Promise<CanonicalPromptContext | undefined>;
  knownContext?: CanonicalPromptContext;
  lookupAllowed?: boolean;
  retryToken?: number;
}
export function requestPromptFixture(owner: CanonicalPromptContexts, input: PromptRequestFixture) {
  const request = {
    agentId: input.agentId,
    source: input.source,
    channel: input.channel,
    signal: input.signal,
    lookup: rawPromptLookup(input.source, input.fetchContext, input.agentId),
    lookupAllowed: input.lookupAllowed ?? true,
    retryToken: input.retryToken ?? 0,
  };
  // Unknown render objects are deliberately extra fixture input, not an owner
  // enrollment API. Direct adversarial cases also exercise this boundary.
  return owner.request(Object.assign(request, { knownContext: input.knownContext }));
}
