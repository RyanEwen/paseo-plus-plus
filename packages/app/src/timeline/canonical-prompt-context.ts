import {
  EMPTY_SOURCE_METADATA,
  reconcileCanonicalSourceMetadata,
  type AcceptedCanonicalSources,
  type CanonicalSourceMetadata,
} from "./canonical-source-metadata";
import { canonicalCoverageForCursor } from "./canonical-reading-source";
import type { ContextPageReader, ContextPromptIndexReader } from "./read-canonical-prompt-context";
import {
  canonicalPromptSourceKey,
  type CanonicalPromptContext,
  type CanonicalTimelineCoverage,
} from "./canonical-prompt-model";
import {
  acceptsAgent,
  EMPTY_CONTEXTS,
  eligible,
  ensureScope,
  observe,
  ordinaryFor,
  publish,
  reconcileSupport,
  resolveCurrent,
  retireAgent,
  retireScope,
  type OrdinaryObservation,
  type PromptContextOwnerState,
} from "./prompt-context-scope";
import { requestPromptContext } from "./prompt-context-request";
import type { StreamItem } from "@/types/stream";

type Prompt = Extract<StreamItem, { kind: "user_message" }>;
export interface RetainedPromptSnapshot {
  epoch: string;
  contexts: readonly CanonicalPromptContext[];
  /** Isolated canonical points never extend viewed contiguous coverage. */
  ranges: readonly { startSeq: number; endSeq: number }[];
}
export interface CanonicalPromptOrdinaryState {
  items: readonly StreamItem[];
  metadata?: readonly CanonicalSourceMetadata[];
  coverage?: readonly CanonicalTimelineCoverage[];
}
export interface CanonicalPromptLookup {
  agentId: string;
  readPage: ContextPageReader;
  projection: "projected" | "canonical";
  /** Optional root capability. Starts a fresh complete index read after source proof. */
  readPromptIndex?: ContextPromptIndexReader;
}
export interface CanonicalPromptRequest {
  agentId: string;
  source: StreamItem;
  channel: object;
  signal: AbortSignal;
  lookup: CanonicalPromptLookup | undefined;
  lookupAllowed: boolean;
  retryToken: number;
}
const EMPTY_REVISION = Object.freeze({});

/** Canonical rows and reuse certificates have separate lifetimes. Only committed
 * reader contexts support a lineage; display previews never acquire support.
 * Scope lifecycle lives in prompt-context-scope.ts and request handling in
 * prompt-context-request.ts; this owner wires them to ordinary rows and listeners. */
export function createCanonicalPromptContexts(
  acceptsEpoch: (agentId: string, epoch: string) => boolean = () => true,
  readOrdinary?: (agentId: string) => CanonicalPromptOrdinaryState | undefined,
  subscribeOrdinary?: (observe: (observation: OrdinaryObservation) => void) => () => void,
) {
  const listeners = new Set<() => void>();
  let stopObserving: (() => void) | undefined;
  const state: PromptContextOwnerState = {
    acceptsEpoch,
    readOrdinary,
    scopes: new Map(),
    snapshots: new Map(),
    bindings: new WeakMap(),
    sourceRevisions: new WeakMap(),
    readers: new Map(),
    channels: new Map(),
    disposed: false,
    retainedAgents: null,
    emit,
    onScopeCreated: startObserving,
  };
  function emit() {
    for (const listener of listeners) listener();
  }
  /** Subscribe when the first scope is admitted. Observations before then are no-ops, and an
   * owner React builds during a render it later discards must not hold a store subscription. */
  function startObserving() {
    if (stopObserving || state.disposed || !subscribeOrdinary) return;
    stopObserving = subscribeOrdinary((observation) => {
      if (!state.disposed && observe(state, observation)) emit();
    });
  }
  return {
    request: (input: CanonicalPromptRequest) => requestPromptContext(state, input),
    preview(agentId: string, source: StreamItem) {
      return resolveCurrent(state, agentId, source)?.context;
    },
    isSupportedContext(agentId: string, context: CanonicalPromptContext) {
      const scope = state.scopes.get(agentId);
      return (
        !state.disposed &&
        !!scope &&
        acceptsAgent(state, agentId) &&
        acceptsEpoch(agentId, scope.epoch) &&
        eligible(state, scope, context, ordinaryFor(state, agentId))
      );
    },
    readExactContext(agentId: string, source: StreamItem) {
      const resolution = resolveCurrent(state, agentId, source);
      return resolution?.parent?.sourceKey === canonicalPromptSourceKey(source)
        ? resolution.context
        : undefined;
    },
    prepareSources(agentId: string, input: AcceptedCanonicalSources) {
      if (state.disposed || !acceptsAgent(state, agentId) || input.cursor?.epoch !== input.epoch)
        return;
      const scope = ensureScope(state, agentId, input.epoch);
      scope.metadata = reconcileCanonicalSourceMetadata(scope.metadata, input);
      scope.items = [...input.tail, ...input.head];
      scope.coverage = canonicalCoverageForCursor(input.cursor);
      observe(state, { agentId, epoch: input.epoch, items: scope.items });
      scope.revision = {};
    },
    publishSources() {
      if (!state.disposed) emit();
    },
    readRevision(agentId: string, epoch: string | null) {
      const scope = state.scopes.get(agentId);
      return scope?.epoch === epoch ? scope.revision : EMPTY_REVISION;
    },
    readSourceMetadata(agentId: string, epoch: string | null) {
      const scope = state.scopes.get(agentId);
      return epoch && acceptsEpoch(agentId, epoch) && scope?.epoch === epoch
        ? scope.metadata
        : EMPTY_SOURCE_METADATA;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    read(
      agentId: string,
      epoch: string | null,
      channel?: object,
    ): readonly CanonicalPromptContext[] {
      if (channel) {
        const reader = state.readers.get(channel);
        return reader?.agentId === agentId && reader.epoch === epoch
          ? reader.contexts
          : EMPTY_CONTEXTS;
      }
      const snapshot = state.snapshots.get(agentId);
      return snapshot?.epoch === epoch ? snapshot.contexts : EMPTY_CONTEXTS;
    },
    snapshot(agentId: string) {
      return state.snapshots.get(agentId);
    },
    setEpoch(agentId: string, epoch: string) {
      if (!state.disposed && acceptsAgent(state, agentId) && acceptsEpoch(agentId, epoch)) {
        ensureScope(state, agentId, epoch);
        emit();
      }
    },
    cancel(channel: object) {
      state.channels.delete(channel);
    },
    release(channel: object) {
      state.channels.delete(channel);
      const reader = state.readers.get(channel);
      if (!reader) return;
      state.readers.delete(channel);
      const scope = state.scopes.get(reader.agentId);
      if (!state.disposed && scope?.epoch === reader.epoch) {
        reconcileSupport(state, scope);
        publish(state, reader.agentId, scope);
      }
    },
    retainAgents(agentIds: readonly string[]) {
      state.retainedAgents = new Set(agentIds);
      for (const agentId of state.scopes.keys())
        if (!state.retainedAgents.has(agentId)) retireAgent(state, agentId);
      emit();
    },
    dispose() {
      state.disposed = true;
      stopObserving?.();
      for (const scope of state.scopes.values()) retireScope(scope);
      state.channels.clear();
      state.readers.clear();
      state.scopes.clear();
      state.snapshots.clear();
      emit();
      listeners.clear();
    },
  };
}
export type CanonicalPromptContexts = ReturnType<typeof createCanonicalPromptContexts>;

/** The ordinary canonical revision wins as a retained point enters the viewed range. */
export function mergeRetainedPrompts(
  items: StreamItem[],
  retained: readonly CanonicalPromptContext[],
  head: readonly StreamItem[] = [],
): StreamItem[] {
  // The common case has nothing retained; skip the whole-tail identity sets per streamed delta.
  if (retained.length === 0) return items;
  const ordinary = [...items, ...head];
  const ids = new Set(ordinary.map((item) => item.id));
  const positions = new Set(
    ordinary.flatMap((item) =>
      item.timelineCursor ? [`${item.timelineCursor.epoch}:${item.timelineCursor.seq}`] : [],
    ),
  );
  const added: Prompt[] = [];
  for (let index = retained.length - 1; index >= 0; index -= 1) {
    const { prompt } = retained[index]!;
    const key = `${prompt.timelineCursor?.epoch}:${prompt.timelineCursor?.seq}`;
    if (ids.has(prompt.id) || positions.has(key)) continue;
    ids.add(prompt.id);
    positions.add(key);
    added.push(prompt);
  }
  if (!added.length) return items;
  const merged = [...items];
  for (const prompt of added.sort((a, b) => a.timelineCursor!.seq - b.timelineCursor!.seq)) {
    const index = merged.findIndex(
      (item) =>
        item.timelineCursor?.epoch === prompt.timelineCursor!.epoch &&
        item.timelineCursor.seq > prompt.timelineCursor!.seq,
    );
    if (index < 0) merged.push(prompt);
    else merged.splice(index, 0, prompt);
  }
  return merged;
}

/** Membership follows the winning full canonical revision before presentation.
 * A local slice must not restore stale content or bypass a plugin's projection.
 */
export function retainedCanonicalPositions(
  items: readonly StreamItem[],
  retained: readonly CanonicalPromptContext[],
): ReadonlySet<string> {
  const ids = new Set(retained.map(({ prompt }) => prompt.id));
  const positions = new Set(
    retained.map(({ prompt }) => `${prompt.timelineCursor!.epoch}:${prompt.timelineCursor!.seq}`),
  );
  return new Set(
    items.flatMap((item) => {
      const cursor = item.timelineCursor;
      if (!cursor || (!ids.has(item.id) && !positions.has(`${cursor.epoch}:${cursor.seq}`)))
        return [];
      return [`${cursor.epoch}:${cursor.seq}`];
    }),
  );
}
