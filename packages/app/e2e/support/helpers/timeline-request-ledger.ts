import type { FetchAgentTimelineResponseMessage } from "@getpaseo/protocol/messages";
import { TIMELINE_FETCH_PAGE_SIZE } from "../../../src/timeline/timeline-fetch-policy";

type TimelineRequestSchemas = Pick<
  typeof import("@getpaseo/protocol/messages"),
  | "AgentTimelineEntryPayloadSchema"
  | "AgentTimelineListPromptsResponseMessageSchema"
  | "FetchAgentTimelineRequestMessageSchema"
  | "FetchAgentTimelineResponseMessageSchema"
>;

export type TimelineReadPurpose = "window" | "content" | "context";
interface ContentTarget {
  epoch: string;
  seq: number;
}

/** Account for every before request, with independent capability-validated cache reads.
 * Violations are retained for the owning test assertion instead of escaping a socket callback.
 * Cache reads never become held history pages or enter the projected-row ownership ledger.
 */
export function createTimelineRequestLedger(agentId: string, schemas: TimelineRequestSchemas) {
  // The browser harness injects its native ESM protocol instance. A static runtime
  // import here would make Playwright transform a second instance before client loading.
  const {
    AgentTimelineEntryPayloadSchema,
    AgentTimelineListPromptsResponseMessageSchema,
    FetchAgentTimelineRequestMessageSchema,
    FetchAgentTimelineResponseMessageSchema,
  } = schemas;
  let indexed = false;
  let indexEpoch: string | null = null;
  let promptSeqs = new Set<number>();
  const loaded = new Set<string>();
  const content = new Map<string, ContentTarget>();
  const requestedContent = new Set<string>();
  const completedContent = new Set<string>();
  const certifiedPrompts = new Map<string, { id: string; text: string }>();
  const adoptedPromptIds = new Set<string>();
  let mountingPrompt: { id: string; text: string } | null = null;
  let mountingOwnerKey: string | null = null;
  const purposes = new Map<string, TimelineReadPurpose>();
  const errors: string[] = [];
  const sources = new Map<
    string,
    FetchAgentTimelineResponseMessage["payload"]["entries"][number]
  >();
  const contextRequests = new Map<
    string,
    { epoch: string; cursor: number; probe: boolean; chainKey: string }
  >();
  const contextSources = new Set<string>();
  const completedContext = new Set<string>();
  interface ContextChain {
    epoch: string;
    cursor: number;
    used: number;
    pendingRequestId: string | null;
    key: string;
    terminal: boolean;
    source: FetchAgentTimelineResponseMessage["payload"]["entries"][number];
  }
  const contextChains = new Map<string, ContextChain>();
  let currentChainKey: string | null = null;
  let allBefore = 0;
  let windowBefore = 0;

  const reject = (reason: string) => {
    errors.push(reason);
    return undefined;
  };

  /** Preserve only the nearest prompt certified by a validated, completed backward page. */
  const certifyNearestPrompt = (
    entries: FetchAgentTimelineResponseMessage["payload"]["entries"],
    ownerKey: string | null = currentChainKey,
  ) => {
    const prompt = entries
      .filter((entry) => entry.item.type === "user_message")
      .sort((left, right) => right.seqEnd - left.seqEnd)[0]?.item;
    if (prompt?.type !== "user_message") return false;
    if (!prompt.messageId) {
      reject("Certified prompt must carry its exact message identity");
      return true;
    }
    const certificate = { id: prompt.messageId, text: prompt.text };
    certifiedPrompts.set(prompt.messageId, certificate);
    if (ownerKey === currentChainKey) {
      mountingPrompt = certificate;
      mountingOwnerKey = ownerKey;
    }
    return true;
  };

  /** Classify source probes and backward reads without consuming a viewed-window slot. */
  const classifyContext = (
    request: Record<string, unknown>,
    id: string,
    cursor: { epoch: string; seq: number },
  ): TimelineReadPurpose | undefined => {
    if (request.mergeWindow === true) return reject("Context cannot apply a viewed window");
    if (request.projection === "projected" && request.limit === 1) {
      const key = `${cursor.epoch}:${cursor.seq - 1}`;
      const source = sources.get(key);
      if (!source || contextSources.has(key))
        return reject("Context probe must name one uncached loaded source occurrence");
      contextSources.add(key);
      contextChains.set(id, {
        epoch: cursor.epoch,
        cursor: cursor.seq,
        used: 1,
        pendingRequestId: id,
        key: id,
        terminal: false,
        source,
      });
      // Cancellation does not retract wire requests. Supersede only mounting ownership.
      currentChainKey = id;
      contextRequests.set(id, {
        epoch: cursor.epoch,
        cursor: cursor.seq,
        probe: true,
        chainKey: id,
      });
    } else {
      const eligible = [...contextChains.values()].filter(
        (candidate) =>
          !candidate.terminal &&
          candidate.pendingRequestId === null &&
          candidate.used < 8 &&
          cursor.epoch === candidate.epoch &&
          cursor.seq === candidate.cursor,
      );
      if (
        request.projection !== "canonical" ||
        request.limit !== TIMELINE_FETCH_PAGE_SIZE ||
        eligible.length !== 1
      )
        return reject("Context page does not belong to the bounded canonical probe chain");
      const chain = eligible[0]!;
      chain.used += 1;
      chain.pendingRequestId = id;
      contextRequests.set(id, {
        epoch: cursor.epoch,
        cursor: cursor.seq,
        probe: false,
        chainKey: chain.key,
      });
    }
    purposes.set(id, "context");
    return "context";
  };

  /** Indexed cache reads require a capability and one uncached canonical USER target. */
  const classifyIndexedContent = (
    request: Record<string, unknown>,
    id: string,
    cursor: { epoch: string; seq: number },
  ): TimelineReadPurpose | undefined => {
    if (
      request.projection !== "projected" ||
      request.limit !== 1 ||
      request.mergeWindow === true ||
      !indexed ||
      cursor.epoch !== indexEpoch
    ) {
      return reject("Unclassified before request purpose or capability");
    }
    const seq = cursor.seq! - 1;
    const key = `${cursor.epoch}:${seq}`;
    if (!promptSeqs.has(seq) || loaded.has(key) || requestedContent.has(key)) {
      return reject("Content read must target one uncached canonical indexed prompt per epoch");
    }
    requestedContent.add(key);
    content.set(id, { epoch: cursor.epoch, seq });
    purposes.set(id, "content");
    return "content";
  };

  return {
    /** Observe actual advertised capability and the canonical index before classifying reads. */
    observe(message: Record<string, unknown>, payload: Record<string, unknown> | null) {
      if (message.type === "status" && payload?.status === "server_info") {
        const features = payload.features as Record<string, unknown> | undefined;
        indexed = features?.agentTimelinePromptIndex === true;
      }
      if (message.type !== "agent.timeline.list_prompts.response" || payload?.agentId !== agentId)
        return;
      const result = AgentTimelineListPromptsResponseMessageSchema.shape.payload.safeParse(payload);
      if (!result.success) {
        indexEpoch = null;
        promptSeqs.clear();
        reject("Malformed canonical prompt index");
        return;
      }
      if (!indexed || result.data.error) return;
      indexEpoch = result.data.epoch;
      promptSeqs = new Set(result.data.prompts.map((prompt) => prompt.seq));
    },

    /** Unknown shapes, repeated IDs and redundant cache reads fail the all-request contract. */
    classify(request: Record<string, unknown>): TimelineReadPurpose | undefined {
      allBefore += 1;
      const parsed = FetchAgentTimelineRequestMessageSchema.safeParse(request);
      if (
        !parsed.success ||
        parsed.data.agentId !== agentId ||
        parsed.data.direction !== "before"
      ) {
        return reject("Invalid before request identity");
      }
      const id = parsed.data.requestId;
      const cursor = parsed.data.cursor;
      if (typeof id !== "string" || purposes.has(id))
        return reject("Missing or repeated timeline request ID");
      if (
        !["projected", "canonical"].includes(String(request.projection)) ||
        typeof cursor?.epoch !== "string" ||
        !Number.isInteger(cursor.seq)
      ) {
        return reject("Unclassified before request projection or cursor");
      }
      // Reading an assistant source can require canonical context even on indexed hosts.
      // Distinguish that observed non-user source from indexed prompt-content reads.
      if (
        request.projection === "canonical" ||
        (request.limit === 1 && sources.has(`${cursor.epoch}:${cursor.seq! - 1}`))
      )
        return classifyContext(request, id, { epoch: cursor.epoch, seq: cursor.seq! });
      if (request.projection === "projected" && request.limit === TIMELINE_FETCH_PAGE_SIZE) {
        purposes.set(id, "window");
        windowBefore += 1;
        return "window";
      }
      return classifyIndexedContent(request, id, { epoch: cursor.epoch, seq: cursor.seq! });
    },

    /** Every before response must belong to one previously classified request. */
    ownsRequest(requestId: unknown) {
      return typeof requestId === "string" && purposes.has(requestId);
    },

    beforeResponsePurpose(payload: Record<string, unknown>) {
      if (payload.agentId !== agentId || payload.direction !== "before")
        return reject("Invalid before response identity");
      const requestId = payload.requestId;
      const purpose = typeof requestId === "string" ? purposes.get(requestId) : undefined;
      if (!purpose) return reject("Unclassified before response request ID");
      return purpose;
    },

    /** Validate one canonical USER response, including its authoritative sequence and projection. */
    completeContent(payload: Record<string, unknown>) {
      const id = String(payload.requestId);
      const target = content.get(id);
      const result = FetchAgentTimelineResponseMessageSchema.shape.payload.safeParse(payload);
      if (!result.success) {
        reject("Malformed canonical prompt-content response");
        if (target) completedContent.add(id);
        return;
      }
      const page = result.data;
      if (!target || completedContent.has(id) || !matchesContentTarget(page, target, agentId)) {
        reject("Invalid or repeated canonical prompt-content response");
        return;
      }
      certifyNearestPrompt(page.entries);
      completedContent.add(id);
    },

    /** Validate cache pages against the actual observed source and strictly decreasing chain. */
    completeContext(payload: Record<string, unknown>) {
      const id = String(payload.requestId);
      const target = contextRequests.get(id);
      const parsed = FetchAgentTimelineResponseMessageSchema.shape.payload.safeParse(payload);
      if (!target || completedContext.has(id) || !parsed.success) {
        reject("Malformed or repeated context response");
        return;
      }
      completedContext.add(id);
      const page = parsed.data;
      const chain = contextChains.get(target.chainKey);
      const fail = (boundary: string) => {
        if (chain) {
          chain.terminal = true;
          chain.pendingRequestId = null;
        }
        reject(`Invalid canonical context response or source identity: ${boundary}`);
      };
      if (
        !chain ||
        chain.terminal ||
        chain.pendingRequestId !== id ||
        !matchesContextPage(page, target, agentId)
      ) {
        fail(chain ? "page ownership/ranges" : "missing chain");
        return;
      }
      if (target.probe) {
        const source = chain.source;
        const entry = page.entries[0];
        if (!entry || !matchesProbeOccurrence(page, source, target)) {
          fail("probe occurrence");
          return;
        }
        // A new validated reading source replaces mounting demand, not historical certification.
        if (chain.key === currentChainKey) {
          mountingPrompt = null;
          mountingOwnerKey = chain.key;
        }
        chain.cursor = entry.seqStart;
      } else {
        if (!matchesContextBounds(page, target)) {
          fail("canonical bounds/progress");
          return;
        }
        if (page.entries.some((entry) => entry.seqEnd >= target.cursor)) {
          fail("canonical bounds/progress");
          return;
        }
        if (certifyNearestPrompt(page.entries, chain.key) || !page.hasOlder) {
          chain.terminal = true;
          chain.pendingRequestId = null;
          return;
        }
        const next = page.entries.length
          ? Math.min(...page.entries.map((entry) => entry.seqStart))
          : target.cursor;
        if (next >= target.cursor) {
          fail("canonical bounds/progress");
          return;
        }
        chain.cursor = next;
        if (chain.used === 8) {
          chain.terminal = true;
          chain.pendingRequestId = null;
          return;
        }
      }
      chain.pendingRequestId = null;
    },

    /** Track prompts already returned by authoritative pages, not by their sticky copies. */
    observeWindow(payload: Record<string, unknown>) {
      if (typeof payload.epoch !== "string" || !Array.isArray(payload.entries)) return;
      for (const entry of payload.entries) {
        const result = AgentTimelineEntryPayloadSchema.safeParse(entry);
        if (result.success && result.data.item.type !== "user_message")
          sources.set(`${payload.epoch}:${result.data.seqEnd}`, result.data);
        if (result.success && result.data.item.type === "user_message") {
          loaded.add(`${payload.epoch}:${result.data.seqEnd}`);
          if (result.data.item.messageId) adoptedPromptIds.add(result.data.item.messageId);
        }
      }
    },

    /** Only exact prompt identities from validated completed content chains may augment rows. */
    certifiedPrompts: () =>
      [...certifiedPrompts.values()].filter((prompt) => !adoptedPromptIds.has(prompt.id)),
    mountingPrompt: () => (mountingOwnerKey === currentChainKey ? mountingPrompt : null),

    summary() {
      return {
        allBefore,
        windowBefore,
        contentBefore: content.size,
        pendingContent: content.size - completedContent.size,
        errors: [...errors],
        ...(contextRequests.size
          ? {
              contextBefore: contextRequests.size,
              pendingContext: contextRequests.size - completedContext.size,
              contextChainActive:
                currentChainKey !== null && !contextChains.get(currentChainKey)!.terminal,
            }
          : {}),
      };
    },
  };
}

/** Match a schema-valid response to the exact cached USER identity, never an overlapping range. */
function matchesContentTarget(
  page: FetchAgentTimelineResponseMessage["payload"],
  target: ContentTarget,
  agentId: string,
) {
  if (
    page.agentId !== agentId ||
    page.direction !== "before" ||
    page.epoch !== target.epoch ||
    page.projection !== "projected"
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
function matchesContextPage(
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
function matchesProbeOccurrence(
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
function matchesContextBounds(
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
