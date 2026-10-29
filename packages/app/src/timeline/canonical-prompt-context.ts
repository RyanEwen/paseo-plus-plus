import {
  EMPTY_SOURCE_METADATA,
  reconcileCanonicalSourceMetadata,
  resolveCanonicalSourceMetadata,
  hasCanonicalSourceEvidence,
  type AcceptedCanonicalSources,
  type CanonicalSourceMetadata,
} from "./canonical-source-metadata";
import {
  canonicalCoverageForCursor,
  hasInterveningUser,
  resolveKnownPromptResolution,
  resolveOrdinaryPromptContext,
  type CanonicalPromptResolution,
} from "./canonical-reading-source";
import {
  fetchCanonicalPromptContext,
  type ContextPageReader,
  type ContextPromptIndexReader,
} from "./read-canonical-prompt-context";
import {
  canonicalPromptSourceKey,
  CanonicalPromptContextBudgetError,
  type CanonicalPromptContext,
  type CanonicalPromptContextProgress,
  type CanonicalTimelineCoverage,
} from "./canonical-prompt-model";
import type { StreamItem } from "@/types/stream";
export {
  canonicalPromptOccurrenceKey,
  canonicalPromptSourceKey,
  CanonicalPromptContextBudgetError,
} from "./canonical-prompt-model";
export type {
  CanonicalPromptContext,
  CanonicalPromptContextProgress,
  CanonicalTimelineCoverage,
} from "./canonical-prompt-model";
export { hasInterveningUser as isPromptContextContradicted } from "./canonical-reading-source";

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
interface OrdinaryObservation {
  agentId: string;
  epoch: string | null;
  items: readonly StreamItem[];
}
interface PromptCertificate {
  scope: object;
  prompt: Prompt;
  sourceStart: number;
  state: "active" | "invalid" | "retired";
  supports: number;
}
interface ContextBinding {
  certificate: PromptCertificate;
  sourceRevision: object;
}
interface ContextContinuation {
  progress: CanonicalPromptContextProgress;
  userGeneration: object;
  retryToken: number;
}
interface ReaderLease {
  agentId: string;
  epoch: string;
  contexts: readonly CanonicalPromptContext[];
  continuations: Map<string, ContextContinuation>;
  blocked: Map<string, number>;
}
interface AgentContextScope {
  identity: object;
  epoch: string;
  items: readonly StreamItem[];
  metadata: readonly CanonicalSourceMetadata[];
  coverage: readonly CanonicalTimelineCoverage[];
  userPositions: ReadonlySet<string> | null;
  userGeneration: object;
  certificates: Set<PromptCertificate>;
  revision: object;
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
export class CanonicalPromptContextChangedError extends Error {
  constructor() {
    super("Reading context changed; retry to resolve the current prompt");
  }
}
const MAX_CONTEXTS_PER_READER = 4;
const EMPTY: readonly CanonicalPromptContext[] = Object.freeze([]);
const EMPTY_REVISION = Object.freeze({});
export function retainCanonicalPromptContext(
  contexts: readonly CanonicalPromptContext[],
  proof: CanonicalPromptContext,
): readonly CanonicalPromptContext[] {
  if (contexts.at(-1) === proof) return contexts;
  return [...contexts.filter((item) => item.sourceKey !== proof.sourceKey), proof].slice(
    -MAX_CONTEXTS_PER_READER,
  );
}
function userPositions(items: readonly StreamItem[], epoch: string): ReadonlySet<string> {
  return new Set(
    items.flatMap((item) =>
      item.kind === "user_message" && item.timelineCursor?.epoch === epoch
        ? [String(item.timelineCursor.seq)]
        : [],
    ),
  );
}
function samePositions(previous: ReadonlySet<string> | null, next: ReadonlySet<string>): boolean {
  return (
    previous !== null &&
    previous.size === next.size &&
    Array.from(next).every((key) => previous.has(key))
  );
}
function retainBounded<K, V>(entries: Map<K, V>, key: K, value: V): void {
  entries.delete(key);
  entries.set(key, value);
  if (entries.size > MAX_CONTEXTS_PER_READER) entries.delete(entries.keys().next().value!);
}

/** Canonical rows and reuse certificates have separate lifetimes. Only committed
 * reader contexts support a lineage; display previews never acquire support. */
export function createCanonicalPromptContexts(
  acceptsEpoch: (agentId: string, epoch: string) => boolean = () => true,
  readOrdinary?: (agentId: string) => CanonicalPromptOrdinaryState | undefined,
  subscribeOrdinary?: (observe: (observation: OrdinaryObservation) => void) => () => void,
) {
  const scopes = new Map<string, AgentContextScope>();
  const snapshots = new Map<string, RetainedPromptSnapshot>();
  const bindings = new WeakMap<CanonicalPromptContext, ContextBinding>();
  const sourceRevisions = new WeakMap<StreamItem, object>();
  const readers = new Map<object, ReaderLease>();
  const listeners = new Set<() => void>();
  const channels = new Map<object, object>();
  let disposed = false;
  let retainedAgents: Set<string> | null = null;
  function emit() {
    for (const listener of listeners) listener();
  }
  function acceptsAgent(agentId: string) {
    return retainedAgents === null || retainedAgents.has(agentId);
  }
  function revisionFor(source: StreamItem) {
    let revision = sourceRevisions.get(source);
    if (!revision) {
      revision = {};
      sourceRevisions.set(source, revision);
    }
    return revision;
  }
  function ordinaryFor(agentId: string): Required<CanonicalPromptOrdinaryState> {
    const scope = scopes.get(agentId);
    const current = readOrdinary?.(agentId);
    return {
      items: current?.items ?? scope?.items ?? [],
      metadata: current?.metadata ?? scope?.metadata ?? EMPTY_SOURCE_METADATA,
      coverage: current?.coverage ?? scope?.coverage ?? [],
    };
  }
  function retireScope(scope: AgentContextScope) {
    for (const certificate of scope.certificates) {
      if (certificate.state === "active") certificate.state = "retired";
      certificate.supports = 0;
    }
    scope.certificates.clear();
    scope.items = [];
    scope.metadata = EMPTY_SOURCE_METADATA;
    scope.coverage = [];
    scope.userPositions = null;
  }
  function retireAgent(agentId: string) {
    const scope = scopes.get(agentId);
    if (scope) retireScope(scope);
    scopes.delete(agentId);
    snapshots.delete(agentId);
    for (const [channel, reader] of readers)
      if (reader.agentId === agentId) {
        readers.delete(channel);
        channels.delete(channel);
      }
  }
  function ensureScope(agentId: string, epoch: string): AgentContextScope {
    const previous = scopes.get(agentId);
    if (previous?.epoch === epoch) return previous;
    if (previous) retireAgent(agentId);
    const scope: AgentContextScope = {
      identity: {},
      epoch,
      items: [],
      metadata: EMPTY_SOURCE_METADATA,
      coverage: [],
      userPositions: null,
      userGeneration: {},
      certificates: new Set(),
      revision: {},
    };
    scopes.set(agentId, scope);
    snapshots.set(agentId, { epoch, contexts: EMPTY, ranges: [] });
    return scope;
  }
  function observe({ agentId, epoch, items }: OrdinaryObservation): boolean {
    const scope = scopes.get(agentId);
    if (!scope) return false;
    if (!epoch || scope.epoch !== epoch) {
      retireAgent(agentId);
      return true;
    }
    const positions = userPositions(items, epoch);
    let changed = !samePositions(scope.userPositions, positions);
    if (changed) {
      scope.userPositions = positions;
      scope.userGeneration = {};
    }
    for (const certificate of scope.certificates) {
      if (certificate.state === "active" && hasInterveningUser(certificate, items)) {
        certificate.state = "invalid";
        changed = true;
      }
    }
    if (changed) scope.revision = {};
    return changed;
  }
  function reconcileSupport(scope: AgentContextScope) {
    for (const certificate of scope.certificates) certificate.supports = 0;
    for (const reader of readers.values()) {
      for (const context of reader.contexts) {
        const certificate = bindings.get(context)?.certificate;
        if (certificate?.scope === scope.identity) certificate.supports += 1;
      }
    }
    for (const certificate of scope.certificates)
      if (!certificate.supports) {
        if (certificate.state === "active") certificate.state = "retired";
        scope.certificates.delete(certificate);
      }
    scope.revision = {};
  }
  function publish(agentId: string, scope: AgentContextScope) {
    const contexts = Array.from(readers.values())
      .filter((reader) => reader.agentId === agentId && reader.epoch === scope.epoch)
      .flatMap((reader) => reader.contexts);
    const points = Array.from(
      new Set(contexts.map(({ prompt }) => prompt.timelineCursor!.seq)),
    ).sort((a, b) => a - b);
    snapshots.set(agentId, {
      epoch: scope.epoch,
      contexts,
      ranges: points.map((seq) => ({ startSeq: seq, endSeq: seq })),
    });
    emit();
  }
  function eligible(
    scope: AgentContextScope,
    context: CanonicalPromptContext,
    ordinary: Required<CanonicalPromptOrdinaryState>,
  ) {
    const certificate = bindings.get(context)?.certificate;
    return (
      certificate?.scope === scope.identity &&
      certificate.state === "active" &&
      certificate.supports > 0 &&
      !hasInterveningUser(certificate, ordinary.items)
    );
  }
  function currentSource(
    source: StreamItem,
    ordinary: Required<CanonicalPromptOrdinaryState>,
  ): StreamItem {
    const key = canonicalPromptSourceKey(source);
    return ordinary.items.find((item) => canonicalPromptSourceKey(item) === key) ?? source;
  }
  function resolveCurrent(
    agentId: string,
    source: StreamItem,
  ): CanonicalPromptResolution | undefined {
    const epoch = source.timelineCursor?.epoch;
    if (disposed || !epoch || !acceptsAgent(agentId) || !acceptsEpoch(agentId, epoch))
      return undefined;
    const scope = scopes.get(agentId);
    if (scope && scope.epoch !== epoch) return undefined;
    const ordinary = ordinaryFor(agentId);
    const actual = currentSource(source, ordinary);
    const contexts = scope
      ? (snapshots.get(agentId)?.contexts ?? EMPTY).filter((context) =>
          eligible(scope, context, ordinary),
        )
      : EMPTY;
    const descriptor = resolveCanonicalSourceMetadata(ordinary.metadata, actual);
    const exact = contexts.find((context) => {
      if (context.sourceKey !== canonicalPromptSourceKey(actual)) return false;
      if (hasCanonicalSourceEvidence(ordinary.metadata, actual))
        return descriptor?.startSeq === context.sourceStart;
      return bindings.get(context)?.sourceRevision === sourceRevisions.get(actual);
    });
    const resolution = resolveKnownPromptResolution({
      source: actual,
      metadata: ordinary.metadata,
      items: ordinary.items,
      coverage: ordinary.coverage,
      contexts,
      exactContext: exact,
    });
    if (!resolution) return undefined;
    if (!resolution.parent && (!descriptor || !ordinary.items.includes(actual))) return undefined;
    return resolution;
  }
  function admit(
    agentId: string,
    reader: ReaderLease,
    source: StreamItem,
    resolution: CanonicalPromptResolution,
  ): Prompt | undefined {
    const scope = scopes.get(agentId)!;
    const parent = resolution.parent;
    let certificate = parent ? bindings.get(parent)?.certificate : undefined;
    if (parent && (!certificate || !eligible(scope, parent, ordinaryFor(agentId))))
      return undefined;
    if (!certificate)
      certificate = {
        scope: scope.identity,
        prompt: resolution.context.prompt,
        sourceStart: resolution.context.sourceStart,
        state: "active",
        supports: 0,
      };
    const context = resolution.context;
    if (bindings.has(context) && bindings.get(context)?.certificate !== certificate)
      throw new Error("Prompt context provenance changed");
    certificate.sourceStart = Math.max(certificate.sourceStart, context.sourceStart);
    bindings.set(context, {
      certificate,
      sourceRevision: revisionFor(currentSource(source, ordinaryFor(agentId))),
    });
    scope.certificates.add(certificate);
    // Install first: replacing the last supporting row with its derived row is
    // one committed handoff, not a transient zero-support retirement.
    reader.contexts = retainCanonicalPromptContext(reader.contexts, context);
    reconcileSupport(scope);
    publish(agentId, scope);
    return context.prompt;
  }
  function blockChanged(reader: ReaderLease, key: string, retryToken: number): never {
    reader.continuations.delete(key);
    retainBounded(reader.blocked, key, retryToken);
    throw new CanonicalPromptContextChangedError();
  }
  function settleCurrent(input: CanonicalPromptRequest, reader: ReaderLease): Prompt | undefined {
    const local = resolveCurrent(input.agentId, input.source);
    return local ? admit(input.agentId, reader, input.source, local) : undefined;
  }
  function beginRequest(input: CanonicalPromptRequest) {
    const epoch = input.source.timelineCursor?.epoch;
    if (!epoch) throw new Error("Prompt context owner unavailable");
    const available =
      !disposed &&
      acceptsAgent(input.agentId) &&
      !input.signal.aborted &&
      acceptsEpoch(input.agentId, epoch);
    if (!available) throw new Error("Prompt context owner unavailable");
    const scope = ensureScope(input.agentId, epoch);
    observe({ agentId: input.agentId, epoch, items: ordinaryFor(input.agentId).items });
    let reader = readers.get(input.channel);
    if (reader && (reader.agentId !== input.agentId || reader.epoch !== epoch))
      throw new Error("Prompt reader scope changed");
    if (!reader) {
      reader = {
        agentId: input.agentId,
        epoch,
        contexts: EMPTY,
        continuations: new Map(),
        blocked: new Map(),
      };
      readers.set(input.channel, reader);
    }
    const generation = {};
    channels.set(input.channel, generation);
    return {
      input,
      epoch,
      scope,
      reader,
      generation,
      key: canonicalPromptSourceKey(input.source),
      userGeneration: scope.userGeneration,
    };
  }
  type Operation = ReturnType<typeof beginRequest>;
  function isCurrent(operation: Operation) {
    const { input, epoch, scope, reader, generation } = operation;
    return (
      !disposed &&
      !input.signal.aborted &&
      acceptsAgent(input.agentId) &&
      acceptsEpoch(input.agentId, epoch) &&
      channels.get(input.channel) === generation &&
      readers.get(input.channel) === reader &&
      scopes.get(input.agentId) === scope
    );
  }
  function sourceStartConflict(input: CanonicalPromptRequest, sourceStart: number): boolean {
    const ordinary = ordinaryFor(input.agentId);
    const actual = currentSource(input.source, ordinary);
    if (!hasCanonicalSourceEvidence(ordinary.metadata, actual)) return false;
    const descriptor = resolveCanonicalSourceMetadata(ordinary.metadata, actual);
    return !descriptor || descriptor.startSeq !== sourceStart;
  }
  function continuationFor({
    input,
    reader,
    scope,
    key,
  }: Operation): CanonicalPromptContextProgress | undefined {
    const continuation = reader.continuations.get(key);
    if (!continuation) return undefined;
    const sourceChanged = sourceStartConflict(input, continuation.progress.sourceStart);
    if (continuation.userGeneration !== scope.userGeneration || sourceChanged) {
      reader.continuations.delete(key);
      if (input.retryToken === continuation.retryToken)
        return blockChanged(reader, key, input.retryToken);
      return undefined;
    }
    if (input.retryToken === continuation.retryToken)
      throw new CanonicalPromptContextBudgetError(continuation.progress);
    return continuation.progress;
  }
  function settleChanged({ input, reader, key }: Operation): Prompt {
    const settled = settleCurrent(input, reader);
    return settled ?? blockChanged(reader, key, input.retryToken);
  }
  function refreshObservation({ input, epoch }: Operation) {
    observe({ agentId: input.agentId, epoch, items: ordinaryFor(input.agentId).items });
  }
  function acceptLookup(
    operation: Operation,
    proof: CanonicalPromptContext | null | undefined,
    sourceStart: number,
  ): Prompt | null | undefined {
    const { input, reader, scope, key, userGeneration } = operation;
    if (!isCurrent(operation)) throw new Error("Prompt context request is no longer current");
    refreshObservation(operation);
    if (scope.userGeneration !== userGeneration || sourceStartConflict(input, sourceStart))
      return settleChanged(operation);
    reader.continuations.delete(key);
    if (!proof) return proof;
    const ordinary = ordinaryFor(input.agentId);
    if (hasInterveningUser(proof, ordinary.items))
      return blockChanged(reader, key, input.retryToken);
    // The index is only a locator; the proof still requires validated canonical content.
    return admit(input.agentId, reader, input.source, { context: proof, parent: undefined });
  }
  /** Reject obsolete indexed reads before they can acquire content or publish a proof. */
  function assertLookupCurrent(operation: Operation, sourceStart: number | undefined): void {
    if (!isCurrent(operation)) throw new Error("Prompt context request is no longer current");
    refreshObservation(operation);
    if (
      operation.scope.userGeneration !== operation.userGeneration ||
      (sourceStart !== undefined && sourceStartConflict(operation.input, sourceStart))
    )
      throw new CanonicalPromptContextChangedError();
  }
  async function readLookup(
    operation: Operation,
    lookup: CanonicalPromptLookup,
    progress: CanonicalPromptContextProgress | undefined,
  ): Promise<Prompt | null | undefined> {
    const { input, reader, key, scope, userGeneration } = operation;
    let proof: CanonicalPromptContext | null | undefined;
    let validatedStart: number | undefined;
    try {
      proof = await fetchCanonicalPromptContext(
        lookup.readPage,
        input.source,
        input.signal,
        lookup.projection,
        progress,
        (sourceStart) => {
          const ordinary = ordinaryFor(input.agentId);
          return resolveOrdinaryPromptContext(
            ordinary.items,
            currentSource(input.source, ordinary),
            ordinary.coverage,
            sourceStart,
          )?.prompt;
        },
        (sourceStart) => {
          validatedStart = sourceStart;
          if (sourceStartConflict(input, sourceStart))
            throw new CanonicalPromptContextChangedError();
        },
        lookup.readPromptIndex
          ? {
              agentId: lookup.agentId,
              readPromptIndex: lookup.readPromptIndex,
              assertCurrent: () => assertLookupCurrent(operation, validatedStart),
            }
          : undefined,
      );
    } catch (error) {
      if (!isCurrent(operation))
        throw new Error("Prompt context request is no longer current", { cause: error });
      refreshObservation(operation);
      const sourceChanged =
        validatedStart !== undefined && sourceStartConflict(input, validatedStart);
      if (scope.userGeneration !== userGeneration || sourceChanged) return settleChanged(operation);
      if (error instanceof CanonicalPromptContextBudgetError && error.progress.sourceKey === key) {
        if (
          validatedStart === undefined ||
          error.progress.sourceStart !== validatedStart ||
          sourceStartConflict(input, error.progress.sourceStart)
        )
          return settleChanged(operation);
        retainBounded(reader.continuations, key, {
          progress: error.progress,
          userGeneration,
          retryToken: input.retryToken,
        });
      }
      throw error;
    }
    if (validatedStart === undefined) return settleChanged(operation);
    return acceptLookup(operation, proof, validatedStart);
  }
  async function request(input: CanonicalPromptRequest): Promise<Prompt | null | undefined> {
    const operation = beginRequest(input);
    const { reader, key } = operation;
    const local = settleCurrent(input, reader);
    if (local) return local;
    if (!input.lookupAllowed || reader.blocked.get(key) === input.retryToken)
      return blockChanged(reader, key, input.retryToken);
    const progress = continuationFor(operation);
    if (!input.lookup || input.lookup.agentId !== input.agentId)
      throw new Error("Canonical prompt context has a different owner or is unavailable");
    return readLookup(operation, input.lookup, progress);
  }
  const stopObserving = subscribeOrdinary?.((observation) => {
    if (!disposed && observe(observation)) emit();
  });
  return {
    request,
    preview(agentId: string, source: StreamItem) {
      return resolveCurrent(agentId, source)?.context;
    },
    isSupportedContext(agentId: string, context: CanonicalPromptContext) {
      const scope = scopes.get(agentId);
      return (
        !disposed &&
        !!scope &&
        acceptsAgent(agentId) &&
        acceptsEpoch(agentId, scope.epoch) &&
        eligible(scope, context, ordinaryFor(agentId))
      );
    },
    readExactContext(agentId: string, source: StreamItem) {
      const resolution = resolveCurrent(agentId, source);
      return resolution?.parent?.sourceKey === canonicalPromptSourceKey(source)
        ? resolution.context
        : undefined;
    },
    prepareSources(agentId: string, input: AcceptedCanonicalSources) {
      if (disposed || !acceptsAgent(agentId) || input.cursor?.epoch !== input.epoch) return;
      const scope = ensureScope(agentId, input.epoch);
      scope.metadata = reconcileCanonicalSourceMetadata(scope.metadata, input);
      scope.items = [...input.tail, ...input.head];
      scope.coverage = canonicalCoverageForCursor(input.cursor);
      observe({ agentId, epoch: input.epoch, items: scope.items });
      scope.revision = {};
    },
    publishSources() {
      if (!disposed) emit();
    },
    readRevision(agentId: string, epoch: string | null) {
      const scope = scopes.get(agentId);
      return scope?.epoch === epoch ? scope.revision : EMPTY_REVISION;
    },
    readSourceMetadata(agentId: string, epoch: string | null) {
      const scope = scopes.get(agentId);
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
        const reader = readers.get(channel);
        return reader?.agentId === agentId && reader.epoch === epoch ? reader.contexts : EMPTY;
      }
      const snapshot = snapshots.get(agentId);
      return snapshot?.epoch === epoch ? snapshot.contexts : EMPTY;
    },
    snapshot(agentId: string) {
      return snapshots.get(agentId);
    },
    setEpoch(agentId: string, epoch: string) {
      if (!disposed && acceptsAgent(agentId) && acceptsEpoch(agentId, epoch)) {
        ensureScope(agentId, epoch);
        emit();
      }
    },
    cancel(channel: object) {
      channels.delete(channel);
    },
    release(channel: object) {
      channels.delete(channel);
      const reader = readers.get(channel);
      if (!reader) return;
      readers.delete(channel);
      const scope = scopes.get(reader.agentId);
      if (!disposed && scope?.epoch === reader.epoch) {
        reconcileSupport(scope);
        publish(reader.agentId, scope);
      }
    },
    retainAgents(agentIds: readonly string[]) {
      retainedAgents = new Set(agentIds);
      for (const agentId of scopes.keys()) if (!retainedAgents.has(agentId)) retireAgent(agentId);
      emit();
    },
    dispose() {
      disposed = true;
      stopObserving?.();
      for (const scope of scopes.values()) retireScope(scope);
      channels.clear();
      readers.clear();
      scopes.clear();
      snapshots.clear();
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
