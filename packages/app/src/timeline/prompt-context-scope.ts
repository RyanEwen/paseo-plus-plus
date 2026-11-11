import {
  EMPTY_SOURCE_METADATA,
  resolveCanonicalSourceMetadata,
  hasCanonicalSourceEvidence,
  type CanonicalSourceMetadata,
} from "./canonical-source-metadata";
import {
  hasInterveningUser,
  resolveKnownPromptResolution,
  type CanonicalPromptResolution,
} from "./canonical-reading-source";
import {
  canonicalPromptSourceKey,
  CanonicalPromptContextUnavailableError,
  type CanonicalPromptContext,
  type CanonicalPromptContextProgress,
  type CanonicalTimelineCoverage,
} from "./canonical-prompt-model";
import type {
  CanonicalPromptOrdinaryState,
  RetainedPromptSnapshot,
} from "./canonical-prompt-context";
import type { StreamItem } from "@/types/stream";

// Scope and certificate lifecycle for the prompt context owner. Every function takes the
// owner's explicit state record; createCanonicalPromptContexts wires them to its API.

export type Prompt = Extract<StreamItem, { kind: "user_message" }>;

export interface OrdinaryObservation {
  agentId: string;
  epoch: string | null;
  items: readonly StreamItem[];
}
export interface PromptCertificate {
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
export interface ContextContinuation {
  progress: CanonicalPromptContextProgress;
  userGeneration: object;
  retryToken: number;
}
export interface ReaderLease {
  agentId: string;
  epoch: string;
  contexts: readonly CanonicalPromptContext[];
  continuations: Map<string, ContextContinuation>;
  blocked: Map<string, number>;
}
export interface AgentContextScope {
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

/** Everything one prompt context owner holds. Mutated only through this module and the
 * request module, never by callers. */
export interface PromptContextOwnerState {
  acceptsEpoch: (agentId: string, epoch: string) => boolean;
  readOrdinary: ((agentId: string) => CanonicalPromptOrdinaryState | undefined) | undefined;
  scopes: Map<string, AgentContextScope>;
  snapshots: Map<string, RetainedPromptSnapshot>;
  bindings: WeakMap<CanonicalPromptContext, ContextBinding>;
  sourceRevisions: WeakMap<StreamItem, object>;
  readers: Map<object, ReaderLease>;
  channels: Map<object, object>;
  disposed: boolean;
  retainedAgents: Set<string> | null;
  /** Notify owner listeners after an observable change. */
  emit: () => void;
  /** Called whenever a scope is created, so the owner can start observing ordinary rows. */
  onScopeCreated: () => void;
}

export const MAX_CONTEXTS_PER_READER = 4;
export const EMPTY_CONTEXTS: readonly CanonicalPromptContext[] = Object.freeze([]);

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

export function acceptsAgent(state: PromptContextOwnerState, agentId: string): boolean {
  return state.retainedAgents === null || state.retainedAgents.has(agentId);
}

function revisionFor(state: PromptContextOwnerState, source: StreamItem): object {
  let revision = state.sourceRevisions.get(source);
  if (!revision) {
    revision = {};
    state.sourceRevisions.set(source, revision);
  }
  return revision;
}

/** The agent's current ordinary rows, falling back to those its scope last admitted. */
export function ordinaryFor(
  state: PromptContextOwnerState,
  agentId: string,
): Required<CanonicalPromptOrdinaryState> {
  const scope = state.scopes.get(agentId);
  const current = state.readOrdinary?.(agentId);
  return {
    items: current?.items ?? scope?.items ?? [],
    metadata: current?.metadata ?? scope?.metadata ?? EMPTY_SOURCE_METADATA,
    coverage: current?.coverage ?? scope?.coverage ?? [],
  };
}

export function retireScope(scope: AgentContextScope): void {
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

export function retireAgent(state: PromptContextOwnerState, agentId: string): void {
  const scope = state.scopes.get(agentId);
  if (scope) retireScope(scope);
  state.scopes.delete(agentId);
  state.snapshots.delete(agentId);
  for (const [channel, reader] of state.readers)
    if (reader.agentId === agentId) {
      state.readers.delete(channel);
      state.channels.delete(channel);
    }
}

/** Return the agent's scope for this epoch, retiring a scope from another epoch. */
export function ensureScope(
  state: PromptContextOwnerState,
  agentId: string,
  epoch: string,
): AgentContextScope {
  const previous = state.scopes.get(agentId);
  if (previous?.epoch === epoch) return previous;
  if (previous) retireAgent(state, agentId);
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
  state.scopes.set(agentId, scope);
  state.snapshots.set(agentId, { epoch, contexts: EMPTY_CONTEXTS, ranges: [] });
  state.onScopeCreated();
  return scope;
}

/** Apply an ordinary-row observation; returns whether anything observable changed. */
export function observe(
  state: PromptContextOwnerState,
  { agentId, epoch, items }: OrdinaryObservation,
): boolean {
  const scope = state.scopes.get(agentId);
  if (!scope) return false;
  if (!epoch || scope.epoch !== epoch) {
    retireAgent(state, agentId);
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

/** Recount reader support for the scope's certificates and retire unsupported ones. */
export function reconcileSupport(state: PromptContextOwnerState, scope: AgentContextScope): void {
  for (const certificate of scope.certificates) certificate.supports = 0;
  for (const reader of state.readers.values()) {
    for (const context of reader.contexts) {
      const certificate = state.bindings.get(context)?.certificate;
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

/** Publish the agent's retained snapshot from every reader in its scope's epoch. */
export function publish(
  state: PromptContextOwnerState,
  agentId: string,
  scope: AgentContextScope,
): void {
  const contexts = Array.from(state.readers.values())
    .filter((reader) => reader.agentId === agentId && reader.epoch === scope.epoch)
    .flatMap((reader) => reader.contexts);
  const points = Array.from(new Set(contexts.map(({ prompt }) => prompt.timelineCursor!.seq))).sort(
    (a, b) => a - b,
  );
  state.snapshots.set(agentId, {
    epoch: scope.epoch,
    contexts,
    ranges: points.map((seq) => ({ startSeq: seq, endSeq: seq })),
  });
  state.emit();
}

export function eligible(
  state: PromptContextOwnerState,
  scope: AgentContextScope,
  context: CanonicalPromptContext,
  ordinary: Required<CanonicalPromptOrdinaryState>,
): boolean {
  const certificate = state.bindings.get(context)?.certificate;
  return (
    certificate?.scope === scope.identity &&
    certificate.state === "active" &&
    certificate.supports > 0 &&
    !hasInterveningUser(certificate, ordinary.items)
  );
}

export function currentSource(
  source: StreamItem,
  ordinary: Required<CanonicalPromptOrdinaryState>,
): StreamItem {
  const key = canonicalPromptSourceKey(source);
  return ordinary.items.find((item) => canonicalPromptSourceKey(item) === key) ?? source;
}

/** Resolve a source's prompt from ordinary rows and this scope's eligible contexts. */
export function resolveCurrent(
  state: PromptContextOwnerState,
  agentId: string,
  source: StreamItem,
): CanonicalPromptResolution | undefined {
  const epoch = source.timelineCursor?.epoch;
  if (
    state.disposed ||
    !epoch ||
    !acceptsAgent(state, agentId) ||
    !state.acceptsEpoch(agentId, epoch)
  )
    return undefined;
  const scope = state.scopes.get(agentId);
  if (scope && scope.epoch !== epoch) return undefined;
  const ordinary = ordinaryFor(state, agentId);
  const actual = currentSource(source, ordinary);
  const contexts = scope
    ? (state.snapshots.get(agentId)?.contexts ?? EMPTY_CONTEXTS).filter((context) =>
        eligible(state, scope, context, ordinary),
      )
    : EMPTY_CONTEXTS;
  const descriptor = resolveCanonicalSourceMetadata(ordinary.metadata, actual);
  const exact = contexts.find((context) => {
    if (context.sourceKey !== canonicalPromptSourceKey(actual)) return false;
    if (hasCanonicalSourceEvidence(ordinary.metadata, actual))
      return descriptor?.startSeq === context.sourceStart;
    return state.bindings.get(context)?.sourceRevision === state.sourceRevisions.get(actual);
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

/** Certify a resolved context for the reader and publish it. */
export function admit(
  state: PromptContextOwnerState,
  agentId: string,
  reader: ReaderLease,
  source: StreamItem,
  resolution: CanonicalPromptResolution,
): Prompt | undefined {
  const scope = state.scopes.get(agentId)!;
  const parent = resolution.parent;
  let certificate = parent ? state.bindings.get(parent)?.certificate : undefined;
  if (parent && (!certificate || !eligible(state, scope, parent, ordinaryFor(state, agentId))))
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
  if (state.bindings.has(context) && state.bindings.get(context)?.certificate !== certificate)
    throw new CanonicalPromptContextUnavailableError("provenance-changed");
  certificate.sourceStart = Math.max(certificate.sourceStart, context.sourceStart);
  state.bindings.set(context, {
    certificate,
    sourceRevision: revisionFor(state, currentSource(source, ordinaryFor(state, agentId))),
  });
  scope.certificates.add(certificate);
  // Install first: replacing the last supporting row with its derived row is
  // one committed handoff, not a transient zero-support retirement.
  reader.contexts = retainCanonicalPromptContext(reader.contexts, context);
  reconcileSupport(state, scope);
  publish(state, agentId, scope);
  return context.prompt;
}
