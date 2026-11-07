import type { AgentPersistenceHandle } from "../agent-sdk-types.js";
import type { StoredAgentRecord } from "../agent-storage.js";
import type { ConfiguredClaudeHistoryStorage } from "./binding.js";

/**
 * The contexts a configured Claude session receives at launch so a native identity change
 * (first ID, rewind or fresh rewind) commits through the manager. Kept here so the provider
 * SDK contract only names them.
 */

export interface ClaudeRewindTransition {
  /** Exact provider query/admission must still own this queued mutation. */
  assertCurrent?(): void;
  previous: AgentPersistenceHandle;
  storage: ConfiguredClaudeHistoryStorage;
  /** Omitted only when staging a fresh rewind, before a provider has allocated a native ID. */
  next?: AgentPersistenceHandle;
  /** Local assignment only: called after durable commit, without IO, events or external hooks. */
  adopt(fresh?: ClaudeFreshRewindContext): void;
}
export type CommitClaudeRewind = (transition: ClaudeRewindTransition) => Promise<void>;
export interface ClaudeInitialHistoryContext {
  readonly owner: object;
  admit(): Promise<void>;
  readonly admission?: StoredAgentRecord;
  release(): void;
  commit(input: {
    storage: ConfiguredClaudeHistoryStorage;
    assertCurrent?(): void;
    next: AgentPersistenceHandle;
    adopt(): void;
  }): Promise<void>;
}
export interface ClaudeFreshRewindContext {
  readonly owner: object;
  admit(): Promise<void>;
  readonly admission?: StoredAgentRecord;
  release(): void;
  operationId: string;
  commit: CommitClaudeRewind;
}
