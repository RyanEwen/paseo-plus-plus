import type { StoredAgentRecord } from "../agent-storage.js";
import type { ManagedAgent } from "../agent-manager.js";
import type { AgentPersistenceHandle } from "../agent-sdk-types.js";
import {
  HistoryIdentityCommittedError,
  HistoryStorageConflictError,
  preserveSnapshotHistoryBinding,
  sameHistoryStorage,
  stableDigest as digest,
} from "./binding.js";

/**
 * Claude configured-home identity rules: when a bound chat may take its first native ID or a
 * rewound one, and what ordinary snapshots and creation retries may change. Storage stays
 * provider-neutral; it only offers the queued mutation port below.
 */

/** The one storage capability these transitions need: a mutation inside the record's queue. */
export interface HistoryRecordQueue {
  mutateRecord(
    agentId: string,
    mutate: (existing: StoredAgentRecord | null) => StoredAgentRecord | null,
    onCommitted?: (record: StoredAgentRecord) => void,
  ): Promise<void>;
}

export interface CommitClaudeInitialHandleInput {
  expected: StoredAgentRecord;
  next: AgentPersistenceHandle;
  onCommitted(record: StoredAgentRecord): void;
  assertCurrent?(): void;
}

export interface CommitClaudeRewindInput {
  expected: StoredAgentRecord;
  next?: AgentPersistenceHandle;
  freshOperationId?: string;
  onCommitted(record: StoredAgentRecord): void;
  assertCurrent?(): void;
}

/** Durable Claude identity transitions, injectable so tests can observe or fault them. */
export interface ClaudeIdentityStore {
  /** A queued copy of the record, ordered after every earlier write. */
  captureAdmission(agentId: string): Promise<StoredAgentRecord>;
  /** Bind the first native ID of a still-empty configured creation. */
  commitInitialHandle(input: CommitClaudeInitialHandleInput): Promise<void>;
  /** Deliberate manager-owned Claude rewind; ordinary snapshots cannot change native identity. */
  commitRewind(input: CommitClaudeRewindInput): Promise<void>;
}

/** A registered Claude creation in a configured home that has not received its first native ID. */
export function isBoundEmptyClaudeCreation(record: StoredAgentRecord | null | undefined): boolean {
  if (!record) return false;
  const binding = record.providerHistory;
  const awaitingNativeIdentity = !record.persistence && !record.claudeFreshRewind;
  const registeredCreation =
    binding?.origin === "created" &&
    binding.registration === "registered" &&
    binding.sessionId === null;
  const configuredClaudeHome =
    binding?.storage.kind === "configured-home" && binding.storage.provider === "claude";
  return awaitingNativeIdentity && registeredCreation && configuredClaudeHome;
}
/** A creation request that recreates the same still-empty bound Claude chat. */
export function matchesEmptyClaudeRecreation(
  existing: StoredAgentRecord | null,
  requested: StoredAgentRecord,
): boolean {
  if (!existing || !isBoundEmptyClaudeCreation(existing)) return false;
  const requestsEmptyCreation =
    requested.providerHistory?.origin === "created" && requested.providerHistory.sessionId === null;
  const samePlacement =
    existing.provider === requested.provider &&
    existing.cwd === requested.cwd &&
    existing.workspaceId === requested.workspaceId;
  const sameLaunch =
    digest(existing.config) === digest(requested.config) &&
    digest(existing.launchEnv ?? null) === digest(requested.launchEnv ?? null);
  return requestsEmptyCreation && samePlacement && sameLaunch;
}

// The pending initial/fresh query protects routing identity, not activity/status metadata.
function claudeQueryIdentity(record: StoredAgentRecord) {
  return {
    id: record.id,
    provider: record.provider,
    cwd: record.cwd,
    workspaceId: record.workspaceId,
    archivedAt: record.archivedAt,
    config: record.config,
    launchEnv: record.launchEnv,
    persistence: record.persistence,
    providerHistory: record.providerHistory,
    claudeFreshRewind: record.claudeFreshRewind,
  };
}
function assertClaudeQueryAdmission(expected: StoredAgentRecord, current: StoredAgentRecord): void {
  if (digest(claudeQueryIdentity(expected)) !== digest(claudeQueryIdentity(current)))
    throw new HistoryStorageConflictError("query-admission-identity-changed");
}

function assertClaudeRewindNext(
  current: StoredAgentRecord,
  next: AgentPersistenceHandle,
  operationId: string | undefined,
): void {
  const sameProvider = next.provider === current.provider;
  const newNativeSession =
    !!next.sessionId &&
    next.sessionId !== current.providerHistory?.sessionId &&
    next.nativeHandle === next.sessionId;
  const matchesPendingOperation = current.claudeFreshRewind?.operationId === operationId;
  if (!sameProvider || !newNativeSession || !matchesPendingOperation)
    throw new HistoryStorageConflictError("rewind-handle-conflict");
}
/** Refuse an ordinary snapshot that would race a pending initial or fresh Claude query. */
export function assertPendingClaudeQuerySnapshot(
  current: ManagedAgent,
  existing: StoredAgentRecord | null,
): void {
  const admission =
    current.session?.claudeFreshRewind?.admission ??
    current.session?.claudeInitialHistory?.admission ??
    current.historyQueryAdmission;
  if (admission && existing) assertClaudeQueryAdmission(admission, existing);
}

function applyInitialHandle(
  current: StoredAgentRecord | null,
  input: CommitClaudeInitialHandleInput,
): StoredAgentRecord {
  input.assertCurrent?.();
  const binding = current?.providerHistory;
  if (!current) throw new HistoryStorageConflictError("initial-handle-binding-conflict");
  assertClaudeQueryAdmission(input.expected, current);
  const stillEmpty = !current.persistence && !current.claudeFreshRewind;
  const registeredClaudeCreation =
    binding?.registration === "registered" &&
    binding.origin === "created" &&
    binding.sessionId === null &&
    binding.storage.kind === "configured-home" &&
    binding.storage.provider === "claude";
  const nextIsNativeSession =
    !!input.next.sessionId &&
    input.next.provider === current.provider &&
    input.next.nativeHandle === input.next.sessionId;
  if (!stillEmpty || !registeredClaudeCreation || !nextIsNativeSession || !binding)
    throw new HistoryStorageConflictError("initial-handle-binding-conflict");
  return {
    ...current,
    persistence: input.next,
    providerHistory: { ...binding, sessionId: input.next.sessionId },
    runtimeInfo: current.runtimeInfo
      ? { ...current.runtimeInfo, sessionId: input.next.sessionId }
      : undefined,
  };
}

function applyRewind(current: StoredAgentRecord | null, input: CommitClaudeRewindInput) {
  input.assertCurrent?.();
  if (!current) throw new HistoryStorageConflictError("rewind-canonical-record-changed");
  const binding = current.providerHistory;
  // A pending fresh query may advance activity metadata; compare only its routing identity.
  const comparesQueryIdentity = !!input.freshOperationId && !!current.claudeFreshRewind;
  const recordUnchanged = comparesQueryIdentity
    ? digest(claudeQueryIdentity(current)) === digest(claudeQueryIdentity(input.expected))
    : digest(current) === digest(input.expected);
  const registeredClaudeHome =
    binding?.registration === "registered" &&
    binding.storage.kind === "configured-home" &&
    binding.storage.provider === "claude";
  const bindingMatchesHandle =
    !!current.persistence &&
    binding?.sessionId === current.persistence.sessionId &&
    current.persistence.provider === current.provider;
  if (!recordUnchanged || !registeredClaudeHome || !bindingMatchesHandle || !binding)
    throw new HistoryStorageConflictError("rewind-canonical-record-changed");
  if (input.next) {
    const next = input.next;
    assertClaudeRewindNext(current, next, input.freshOperationId);
    return {
      ...current,
      persistence: next,
      providerHistory: { ...binding, sessionId: next.sessionId },
      runtimeInfo: current.runtimeInfo
        ? { ...current.runtimeInfo, sessionId: next.sessionId }
        : undefined,
      claudeFreshRewind: undefined,
    };
  }
  if (!input.freshOperationId || current.claudeFreshRewind)
    throw new HistoryStorageConflictError("rewind-intent-conflict");
  return { ...current, claudeFreshRewind: { operationId: input.freshOperationId } };
}

/**
 * Run a committed identity's adoption callback. A failure after the durable write reports the
 * committed session, so recovery reopens it from canonical storage.
 */
function adoptCommitted(
  record: StoredAgentRecord,
  onCommitted: (record: StoredAgentRecord) => void,
) {
  try {
    onCommitted(record);
  } catch {
    throw new HistoryIdentityCommittedError(record.persistence?.sessionId);
  }
}

/** The default identity store over an agent record queue. */
export function createClaudeIdentityStore(queue: HistoryRecordQueue): ClaudeIdentityStore {
  return {
    async captureAdmission(agentId) {
      let captured: StoredAgentRecord | undefined;
      await queue.mutateRecord(agentId, (current) => {
        if (current) captured = structuredClone(current);
        return null;
      });
      if (!captured) throw new HistoryStorageConflictError("history-admission-record-missing");
      return captured;
    },
    async commitInitialHandle(input) {
      let committed = false;
      await queue.mutateRecord(
        input.expected.id,
        (current) => applyInitialHandle(current, input),
        (record) => {
          committed = true;
          adoptCommitted(record, input.onCommitted);
        },
      );
      if (!committed) throw new HistoryStorageConflictError("history-identity-write-refused");
    },
    async commitRewind(input) {
      let committed = false;
      // A marked fresh query starts a turn before its first native init. Activity/status
      // snapshots may advance meanwhile; the exact route, recovery handle, config and intent may not.
      await queue.mutateRecord(
        input.expected.id,
        (current) => applyRewind(current, input),
        (record) => {
          committed = true;
          adoptCommitted(record, input.onCommitted);
        },
      );
      if (!committed) throw new HistoryStorageConflictError("history-identity-write-refused");
    },
  };
}

/** Register a bound empty Claude creation once, keeping its created origin and route. */
function claudeEmptyCreationBinding(
  existing: StoredAgentRecord,
  current: ManagedAgent,
  record: StoredAgentRecord,
): StoredAgentRecord["providerHistory"] {
  const previous = existing.providerHistory!;
  const createdWithoutSession = previous.origin === "created" && previous.sessionId === null;
  const noNativeHandle = !record.persistence && !existing.persistence;
  const configuredClaudeHome =
    previous.storage.kind === "configured-home" && previous.storage.provider === "claude";
  const sameCreatedRoute =
    current.provider === existing.provider &&
    current.providerHistory?.origin === "created" &&
    sameHistoryStorage(previous.storage, current.providerHistory.storage);
  if (!createdWithoutSession || !noNativeHandle || !configuredClaudeHome || !sameCreatedRoute)
    throw new HistoryStorageConflictError("empty-creation-registration-conflict");
  return { ...previous, registration: "registered" };
}

/** The provider history binding a snapshot may write: configured bindings only change through guarded paths. */
export function snapshotHistoryBinding(
  existing: StoredAgentRecord | null,
  current: ManagedAgent,
  projected: StoredAgentRecord,
  registerEmptyCreation = false,
): StoredAgentRecord["providerHistory"] {
  if (registerEmptyCreation && existing?.providerHistory?.registration === "intent")
    return claudeEmptyCreationBinding(existing, current, projected);
  const previous = existing?.providerHistory;
  if (previous?.storage.kind === "configured-home") {
    // Projection normalizes registration; validate the original observation first.
    return preserveSnapshotHistoryBinding(previous, current.providerHistory, projected.persistence);
  }
  return projected.providerHistory ?? previous;
}
