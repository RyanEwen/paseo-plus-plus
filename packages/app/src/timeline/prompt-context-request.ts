import {
  hasCanonicalSourceEvidence,
  resolveCanonicalSourceMetadata,
} from "./canonical-source-metadata";
import { hasInterveningUser, resolveOrdinaryPromptContext } from "./canonical-reading-source";
import { fetchCanonicalPromptContext } from "./read-canonical-prompt-context";
import {
  canonicalPromptSourceKey,
  CanonicalPromptContextBudgetError,
  CanonicalPromptContextChangedError,
  CanonicalPromptContextStaleError,
  CanonicalPromptContextUnavailableError,
  retainBounded,
  type CanonicalPromptContext,
  type CanonicalPromptContextProgress,
} from "./canonical-prompt-model";
import type { CanonicalPromptLookup, CanonicalPromptRequest } from "./canonical-prompt-context";
import {
  acceptsAgent,
  admit,
  currentSource,
  EMPTY_CONTEXTS,
  ensureScope,
  MAX_CONTEXTS_PER_READER,
  observe,
  ordinaryFor,
  resolveCurrent,
  type Prompt,
  type PromptContextOwnerState,
  type ReaderLease,
} from "./prompt-context-scope";

// One prompt context request: reader leases, continuations, blocked retries and the
// lookup that proves a prompt when ordinary rows cannot.

interface RequestOperation {
  input: CanonicalPromptRequest;
  epoch: string;
  scope: ReturnType<typeof ensureScope>;
  reader: ReaderLease;
  generation: object;
  key: string;
  userGeneration: object;
}

function blockChanged(reader: ReaderLease, key: string, retryToken: number): never {
  reader.continuations.delete(key);
  retainBounded(reader.blocked, key, retryToken, MAX_CONTEXTS_PER_READER);
  throw new CanonicalPromptContextChangedError();
}

function settleCurrent(
  state: PromptContextOwnerState,
  input: CanonicalPromptRequest,
  reader: ReaderLease,
): Prompt | undefined {
  const local = resolveCurrent(state, input.agentId, input.source);
  return local ? admit(state, input.agentId, reader, input.source, local) : undefined;
}

/** Validate the request, lease its reader channel and stamp a new channel generation. */
function beginRequest(
  state: PromptContextOwnerState,
  input: CanonicalPromptRequest,
): RequestOperation {
  const epoch = input.source.timelineCursor?.epoch;
  if (!epoch) throw new CanonicalPromptContextUnavailableError("owner-unavailable");
  const available =
    !state.disposed &&
    acceptsAgent(state, input.agentId) &&
    !input.signal.aborted &&
    state.acceptsEpoch(input.agentId, epoch);
  if (!available) throw new CanonicalPromptContextUnavailableError("owner-unavailable");
  const scope = ensureScope(state, input.agentId, epoch);
  observe(state, { agentId: input.agentId, epoch, items: ordinaryFor(state, input.agentId).items });
  let reader = state.readers.get(input.channel);
  if (reader && (reader.agentId !== input.agentId || reader.epoch !== epoch))
    throw new CanonicalPromptContextUnavailableError("reader-scope-changed");
  if (!reader) {
    reader = {
      agentId: input.agentId,
      epoch,
      contexts: EMPTY_CONTEXTS,
      continuations: new Map(),
      blocked: new Map(),
    };
    state.readers.set(input.channel, reader);
  }
  const generation = {};
  state.channels.set(input.channel, generation);
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

function isCurrent(state: PromptContextOwnerState, operation: RequestOperation): boolean {
  const { input, epoch, scope, reader, generation } = operation;
  return (
    !state.disposed &&
    !input.signal.aborted &&
    acceptsAgent(state, input.agentId) &&
    state.acceptsEpoch(input.agentId, epoch) &&
    state.channels.get(input.channel) === generation &&
    state.readers.get(input.channel) === reader &&
    state.scopes.get(input.agentId) === scope
  );
}

function sourceStartConflict(
  state: PromptContextOwnerState,
  input: CanonicalPromptRequest,
  sourceStart: number,
): boolean {
  const ordinary = ordinaryFor(state, input.agentId);
  const actual = currentSource(input.source, ordinary);
  if (!hasCanonicalSourceEvidence(ordinary.metadata, actual)) return false;
  const descriptor = resolveCanonicalSourceMetadata(ordinary.metadata, actual);
  return !descriptor || descriptor.startSeq !== sourceStart;
}

/** Resume a budget-limited read only on a new retry token, while its sources still match. */
function continuationFor(
  state: PromptContextOwnerState,
  { input, reader, scope, key }: RequestOperation,
): CanonicalPromptContextProgress | undefined {
  const continuation = reader.continuations.get(key);
  if (!continuation) return undefined;
  const sourceChanged = sourceStartConflict(state, input, continuation.progress.sourceStart);
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

function settleChanged(
  state: PromptContextOwnerState,
  { input, reader, key }: RequestOperation,
): Prompt {
  const settled = settleCurrent(state, input, reader);
  return settled ?? blockChanged(reader, key, input.retryToken);
}

function refreshObservation(state: PromptContextOwnerState, { input, epoch }: RequestOperation) {
  observe(state, { agentId: input.agentId, epoch, items: ordinaryFor(state, input.agentId).items });
}

function acceptLookup(
  state: PromptContextOwnerState,
  operation: RequestOperation,
  proof: CanonicalPromptContext | null | undefined,
  sourceStart: number,
): Prompt | null | undefined {
  const { input, reader, scope, key, userGeneration } = operation;
  if (!isCurrent(state, operation)) throw new CanonicalPromptContextStaleError();
  refreshObservation(state, operation);
  if (scope.userGeneration !== userGeneration || sourceStartConflict(state, input, sourceStart))
    return settleChanged(state, operation);
  reader.continuations.delete(key);
  if (!proof) return proof;
  const ordinary = ordinaryFor(state, input.agentId);
  if (hasInterveningUser(proof, ordinary.items)) return blockChanged(reader, key, input.retryToken);
  // The index is only a locator; the proof still requires validated canonical content.
  return admit(state, input.agentId, reader, input.source, { context: proof, parent: undefined });
}

/** Reject obsolete indexed reads before they can acquire content or publish a proof. */
function assertLookupCurrent(
  state: PromptContextOwnerState,
  operation: RequestOperation,
  sourceStart: number | undefined,
): void {
  if (!isCurrent(state, operation)) throw new CanonicalPromptContextStaleError();
  refreshObservation(state, operation);
  if (
    operation.scope.userGeneration !== operation.userGeneration ||
    (sourceStart !== undefined && sourceStartConflict(state, operation.input, sourceStart))
  )
    throw new CanonicalPromptContextChangedError();
}

async function readLookup(
  state: PromptContextOwnerState,
  operation: RequestOperation,
  lookup: CanonicalPromptLookup,
  progress: CanonicalPromptContextProgress | undefined,
): Promise<Prompt | null | undefined> {
  const { input, reader, key, scope, userGeneration } = operation;
  let proof: CanonicalPromptContext | null | undefined;
  let validatedStart: number | undefined;
  try {
    proof = await fetchCanonicalPromptContext({
      reader: lookup.readPage,
      source: input.source,
      signal: input.signal,
      backwardProjection: lookup.projection,
      progress,
      resolveOrdinary: (sourceStart) => {
        const ordinary = ordinaryFor(state, input.agentId);
        return resolveOrdinaryPromptContext(
          ordinary.items,
          currentSource(input.source, ordinary),
          ordinary.coverage,
          sourceStart,
        )?.prompt;
      },
      observeSourceStart: (sourceStart) => {
        validatedStart = sourceStart;
        if (sourceStartConflict(state, input, sourceStart))
          throw new CanonicalPromptContextChangedError();
      },
      indexedLookup: lookup.readPromptIndex
        ? {
            agentId: lookup.agentId,
            readPromptIndex: lookup.readPromptIndex,
            assertCurrent: () => assertLookupCurrent(state, operation, validatedStart),
          }
        : undefined,
    });
  } catch (error) {
    if (!isCurrent(state, operation)) throw new CanonicalPromptContextStaleError({ cause: error });
    refreshObservation(state, operation);
    const sourceChanged =
      validatedStart !== undefined && sourceStartConflict(state, input, validatedStart);
    if (scope.userGeneration !== userGeneration || sourceChanged)
      return settleChanged(state, operation);
    if (error instanceof CanonicalPromptContextBudgetError && error.progress.sourceKey === key) {
      if (
        validatedStart === undefined ||
        error.progress.sourceStart !== validatedStart ||
        sourceStartConflict(state, input, error.progress.sourceStart)
      )
        return settleChanged(state, operation);
      retainBounded(
        reader.continuations,
        key,
        { progress: error.progress, userGeneration, retryToken: input.retryToken },
        MAX_CONTEXTS_PER_READER,
      );
    }
    throw error;
  }
  if (validatedStart === undefined) return settleChanged(state, operation);
  return acceptLookup(state, operation, proof, validatedStart);
}

/** Resolve the request's prompt locally, or prove it through the lookup when allowed. */
export async function requestPromptContext(
  state: PromptContextOwnerState,
  input: CanonicalPromptRequest,
): Promise<Prompt | null | undefined> {
  const operation = beginRequest(state, input);
  const { reader, key } = operation;
  const local = settleCurrent(state, input, reader);
  if (local) return local;
  if (!input.lookupAllowed || reader.blocked.get(key) === input.retryToken)
    return blockChanged(reader, key, input.retryToken);
  const progress = continuationFor(state, operation);
  if (!input.lookup || input.lookup.agentId !== input.agentId)
    throw new CanonicalPromptContextUnavailableError("lookup-unavailable");
  return readLookup(state, operation, input.lookup, progress);
}
