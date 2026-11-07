import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentPersistenceHandle, AgentPromptInput } from "../../agent-sdk-types.js";
import {
  HistoryIdentityCommittedError,
  HistoryStorageConflictError,
  type ConfiguredClaudeHistoryStorage,
  type ProviderHistoryStorage,
} from "../../provider-history/binding.js";
import type {
  ClaudeFreshRewindContext,
  ClaudeInitialHistoryContext,
} from "../../provider-history/claude-identity-types.js";
import { checkClaudeRewindHandle } from "./history.js";

/** Messages a query may emit before its root init acknowledgment names the native session. */
const MAX_PENDING_IDENTITY_MESSAGES = 100;

/** The session state the identity collaborator reads, and the one adoption it performs. */
export interface ClaudeHistoryIdentityHost {
  isClosed(): boolean;
  currentQuery(): Query | null;
  /** The query is still the session's live query and has not been retired. */
  ownsQuery(query: Query): boolean;
  claudeSessionId(): string | null;
  /** The native session ID an SDK message names, trimmed; empty when it names none. */
  messageSessionId(message: SDKMessage): string;
  /** Session metadata recorded on a first native handle (the config without provider options). */
  sessionMetadata(): AgentPersistenceHandle["metadata"];
  describePersistence(): AgentPersistenceHandle | null;
  resolveHistoryPath(sessionId: string): Promise<string | null>;
  harnessEnvironment(): Record<string, string>;
  /** Switch the session to a committed native identity. */
  adoptIdentity(sessionId: string, persistence: AgentPersistenceHandle): void;
}

/**
 * A configured Claude session's history identity: the bound home, the pending initial or fresh
 * rewind context, and the messages held back until the query's root init names its native ID.
 * The session asks it to admit, buffer and accept; it commits through the manager's contexts.
 */
export class ClaudeHistoryIdentity {
  readonly boundHistory?: ConfiguredClaudeHistoryStorage;
  /** A staged fresh-conversation rewind waiting for its first native ID. */
  freshRewind?: ClaudeFreshRewindContext;
  /** A new configured chat waiting for its first native ID. */
  initialHistory?: ClaudeInitialHistoryContext;
  /** A committed identity could not be adopted; the session must be reloaded. */
  adoptionFailed = false;
  private freshRewindQuery: Query | null = null;
  private initialHistoryQuery: Query | null = null;
  private pendingMessages: SDKMessage[] = [];

  constructor(
    private readonly host: ClaudeHistoryIdentityHost,
    input: {
      storage?: ProviderHistoryStorage;
      freshRewind?: ClaudeFreshRewindContext;
      initialHistory?: ClaudeInitialHistoryContext;
    },
  ) {
    if (input.storage?.kind === "configured-home") {
      if (input.storage.provider !== "claude")
        throw new HistoryStorageConflictError("bound-provider-conflict");
      this.boundHistory = input.storage;
    }
    this.freshRewind = input.freshRewind;
    this.initialHistory = input.initialHistory;
  }

  /** A first or rewound native ID is still pending, so query output waits for its init. */
  get awaitingIdentity(): boolean {
    return !!(this.freshRewind || this.initialHistory);
  }

  /**
   * Refuse a prompt after a failed adoption, and session-switching slash commands typed as text
   * in a bound chat (they would leave the binding).
   */
  assertPrompt(prompt: AgentPromptInput): void {
    if (this.adoptionFailed)
      throw new HistoryStorageConflictError("committed-identity-reload-required");
    if (
      this.boundHistory &&
      typeof prompt === "string" &&
      /^\s*\/(?:clear|new|fork|resume|rewind)(?:\s|$)/i.test(prompt)
    )
      throw new HistoryStorageConflictError("session-switch-command-use-managed-rewind");
  }

  /** Admit the first requested turn of a pending initial or fresh query. */
  async admitPendingQueries(): Promise<void> {
    await this.initialHistory?.admit();
    await this.freshRewind?.admit();
  }

  /** The query that will acknowledge each pending identity. */
  markQueryStarted(query: Query): void {
    if (this.freshRewind) this.freshRewindQuery = query;
    if (this.initialHistory) this.initialHistoryQuery = query;
  }

  /** A retired query can no longer acknowledge an identity; held messages are dropped. */
  forgetQueries(): void {
    this.initialHistoryQuery = null;
    this.freshRewindQuery = null;
    this.pendingMessages = [];
  }

  clearPendingMessages(): void {
    this.pendingMessages = [];
  }

  release(): void {
    this.initialHistory?.release();
    this.freshRewind?.release();
  }

  /**
   * Hold a message that arrives before the root init acknowledgment. Returns true when held;
   * throws once more messages are held than an acknowledgment can plausibly trail.
   */
  bufferUntilInit(message: SDKMessage, parentToolUseId: string | null): boolean {
    if (message.type === "system" && message.subtype === "init" && !parentToolUseId) return false;
    this.pendingMessages.push(message);
    if (this.pendingMessages.length > MAX_PENDING_IDENTITY_MESSAGES)
      throw new HistoryStorageConflictError("identity-acknowledgment-limit");
    return true;
  }

  /** Messages held before the acknowledgment, in arrival order; the buffer is emptied. */
  drainPendingMessages(): SDKMessage[] {
    return this.pendingMessages.splice(0);
  }

  /** Commit whichever pending identity the root init acknowledges. */
  async acceptIdentity(message: SDKMessage, query: Query): Promise<void> {
    await this.acceptInitialIdentity(message, query);
    await this.acceptFreshRewindIdentity(message, query);
  }

  private async acceptInitialIdentity(message: SDKMessage, query: Query): Promise<void> {
    const context = this.initialHistory;
    if (!context || !this.boundHistory) return;
    const id = this.host.messageSessionId(message);
    const file = await this.host.resolveHistoryPath(id);
    if (
      this.host.isClosed() ||
      this.host.currentQuery() !== query ||
      this.initialHistory !== context ||
      this.initialHistoryQuery !== query ||
      this.host.claudeSessionId() ||
      !id ||
      !file
    )
      throw new HistoryStorageConflictError("stale-initial-history-query");
    const metadata = this.host.sessionMetadata();
    const next = { provider: "claude", sessionId: id, nativeHandle: id, metadata };
    const storage = this.boundHistory;
    await this.commitIdentity({
      id,
      file,
      storage,
      failure: "initial child",
      failedStep: "binding failed",
      commit: () =>
        context.commit({
          storage,
          next,
          assertCurrent: () => {
            const stillCurrent = this.initialHistory === context || this.freshRewind === context;
            if (!this.host.ownsQuery(query) || !stillCurrent)
              throw new HistoryStorageConflictError("stale-history-query");
          },
          adopt: () => {
            if (!this.host.ownsQuery(query))
              throw new HistoryStorageConflictError("stale-history-query");
            this.host.adoptIdentity(id, next);
            this.initialHistory = undefined;
            this.initialHistoryQuery = null;
          },
        }),
    });
  }

  /**
   * Check that the new native transcript sits in the bound home, then run the durable commit.
   * A committed identity whose runtime adoption failed marks the session reload-required; any
   * other failure reports the retained child and the refusal reason.
   */
  private async commitIdentity(input: {
    id: string;
    file: string;
    storage: ConfiguredClaudeHistoryStorage;
    /** Names the retained child in the failure message, e.g. "initial child". */
    failure: string;
    /** Names the step that failed, e.g. "binding failed". */
    failedStep: string;
    commit: () => Promise<void>;
  }): Promise<void> {
    try {
      checkClaudeRewindHandle(input.storage, this.host.harnessEnvironment(), input.file);
      await input.commit();
    } catch (error) {
      if (error instanceof HistoryIdentityCommittedError) {
        this.adoptionFailed = true;
        throw new Error(
          `Claude identity ${input.id} committed; runtime adoption failed; reload required`,
          { cause: error },
        );
      }
      const reason =
        error instanceof HistoryStorageConflictError ? error.describe() : "unavailable";
      throw new Error(
        `Claude ${input.failure} ${input.id} retained in ${input.storage.home}; ${input.failedStep} (${reason})`,
        { cause: error },
      );
    }
  }

  private async acceptFreshRewindIdentity(message: SDKMessage, query: Query): Promise<void> {
    const context = this.freshRewind;
    if (!context || !this.boundHistory) return;
    const id = this.host.messageSessionId(message);
    if (!id) return;
    if (
      this.host.isClosed() ||
      this.host.currentQuery() !== query ||
      this.freshRewindQuery !== query
    )
      throw new HistoryStorageConflictError("stale-fresh-rewind-query");
    const previous = this.host.describePersistence();
    const file = await this.host.resolveHistoryPath(id);
    if (!previous || !file || id === previous.sessionId)
      throw new HistoryStorageConflictError("fresh-rewind-handle-conflict");
    if (
      !this.host.ownsQuery(query) ||
      this.freshRewindQuery !== query ||
      this.freshRewind !== context
    )
      throw new HistoryStorageConflictError("stale-fresh-rewind-query");
    const next = { ...previous, sessionId: id, nativeHandle: id };
    const storage = this.boundHistory;
    const assertFreshQuery = () => {
      const stillCurrent = this.freshRewindQuery === query && this.freshRewind === context;
      if (!this.host.ownsQuery(query) || !stillCurrent)
        throw new HistoryStorageConflictError("stale-fresh-rewind-query");
    };
    await this.commitIdentity({
      id,
      file,
      storage,
      failure: "fresh rewind child",
      failedStep: "commit failed",
      commit: () =>
        context.commit({
          previous,
          next,
          storage,
          assertCurrent: assertFreshQuery,
          adopt: () => {
            if (!this.host.ownsQuery(query))
              throw new HistoryStorageConflictError("stale-fresh-rewind-query");
            this.host.adoptIdentity(id, next);
            this.freshRewind = undefined;
            this.freshRewindQuery = null;
          },
        }),
    });
  }
}
