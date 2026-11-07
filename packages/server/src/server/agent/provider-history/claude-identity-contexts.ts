import { randomUUID } from "node:crypto";
import type {
  ClaudeFreshRewindContext,
  ClaudeInitialHistoryContext,
  ClaudeRewindTransition,
} from "./claude-identity-types.js";
import type {
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentRuntimeInfo,
  AgentSession,
  AgentSessionConfig,
} from "../agent-sdk-types.js";
import type { StoredAgentRecord } from "../agent-storage.js";
import {
  HistoryIdentityCommittedError,
  HistoryStorageConflictError,
  sameHistoryStorage,
  type ConfiguredClaudeHistoryStorage,
  type ProviderHistoryBinding,
  type ProviderHistoryStorage,
} from "./binding.js";
import type { ClaudeIdentityStore } from "./claude-identity.js";

/** The live agent fields Claude identity admission reads and adopts. */
export interface ClaudeIdentityAgent {
  readonly id: string;
  readonly provider: string;
  readonly config: AgentSessionConfig;
  readonly session: Pick<
    AgentSession,
    "claudeInitialHistory" | "claudeFreshRewind" | "historyStorage"
  >;
  persistence: AgentPersistenceHandle | null;
  providerHistory?: ProviderHistoryBinding;
  runtimeInfo?: AgentRuntimeInfo;
  lastError?: string;
}

/** What the agent manager lends the coordinator; nothing here is Claude-specific. */
export interface ClaudeIdentityHost<Agent extends ClaudeIdentityAgent> {
  store(): ClaudeIdentityStore;
  requireSessionAgent(agentId: string): Agent;
  /** The agent is still the manager's registered runtime for its ID. */
  isCurrent(agent: Agent): boolean;
  persistSnapshot(agent: Agent): Promise<void>;
  normalizePersistence(
    handle: AgentPersistenceHandle | null,
    config: AgentSessionConfig,
  ): AgentPersistenceHandle | null;
  /** Close a runtime whose committed identity could not be adopted, without another snapshot. */
  retireCommittedRuntime(agent: Agent): Promise<void>;
}

/** Two persistence handles name the same session when their serialized forms are identical. */
function samePersistenceHandle(
  left: AgentPersistenceHandle | null | undefined,
  right: AgentPersistenceHandle | null | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Owns the admit and commit contexts a configured Claude session uses to take its first native
 * ID or a rewound one. Each context proves, inside the record queue, that the agent, route and
 * recovery handle are still the ones admitted before it commits.
 */
export class ClaudeIdentityCoordinator<Agent extends ClaudeIdentityAgent> {
  constructor(private readonly host: ClaudeIdentityHost<Agent>) {}

  /** Give a configured Claude launch the identity contexts its stored record calls for. */
  attachContexts(
    agentId: string,
    context: AgentLaunchContext,
    record: StoredAgentRecord | null | undefined,
    storage: ProviderHistoryStorage | undefined,
  ): void {
    const previous = record?.providerHistory;
    if (
      record &&
      previous?.origin === "created" &&
      previous.sessionId === null &&
      storage?.kind === "configured-home" &&
      storage.provider === "claude" &&
      !record.claudeFreshRewind
    ) {
      context.claudeInitialHistory = this.initialHistoryContext(agentId, storage);
    }
    if (record?.claudeFreshRewind) {
      if (
        previous?.storage.kind !== "configured-home" ||
        previous.storage.provider !== "claude" ||
        !record.persistence
      )
        throw new HistoryStorageConflictError("fresh-rewind-record-conflict");
      context.claudeFreshRewind = this.freshRewindContext(
        agentId,
        record.claudeFreshRewind.operationId,
      );
    }
  }

  private initialHistoryContext(
    agentId: string,
    storage: ConfiguredClaudeHistoryStorage,
  ): ClaudeInitialHistoryContext {
    let admitted: StoredAgentRecord | undefined;
    let conflicted = false;
    const context: ClaudeInitialHistoryContext = {
      owner: {},
      get admission() {
        return admitted;
      },
      release: () => {
        if (!conflicted) admitted = undefined;
      },
      admit: async () => {
        if (conflicted)
          throw new HistoryStorageConflictError("initial-admission-conflict-reload-required");
        const agent = this.host.requireSessionAgent(agentId);
        if (agent.session.claudeInitialHistory?.owner !== context.owner)
          throw new HistoryStorageConflictError("initial-query-admission-conflict");
        await this.host.persistSnapshot(agent);
        const captured = await this.host.store().captureAdmission(agentId);
        const stillOwned = agent.session.claudeInitialHistory?.owner === context.owner;
        const sameRoute =
          captured.provider === agent.provider &&
          sameHistoryStorage(captured.providerHistory?.storage ?? { kind: "unknown" }, storage);
        const stillEmptyCreation =
          captured.providerHistory?.origin === "created" &&
          captured.providerHistory.sessionId === null &&
          !captured.persistence &&
          !captured.claudeFreshRewind;
        if (!stillOwned || !sameRoute || !stillEmptyCreation)
          throw new HistoryStorageConflictError("initial-query-admission-conflict");
        admitted = captured;
      },
      commit: async (transition) => {
        const agent = this.host.requireSessionAgent(agentId);
        const expected = admitted;
        if (
          !expected ||
          agent.session.claudeInitialHistory?.owner !== context.owner ||
          !sameHistoryStorage(
            expected.providerHistory?.storage ?? { kind: "unknown" },
            transition.storage,
          )
        )
          throw new HistoryStorageConflictError("stale-initial-history-callback");
        try {
          await this.host.store().commitInitialHandle({
            expected,
            next: this.host.normalizePersistence(transition.next, agent.config)!,
            assertCurrent: () => {
              transition.assertCurrent?.();
              if (
                !this.host.isCurrent(agent) ||
                agent.session.claudeInitialHistory?.owner !== context.owner
              )
                throw new HistoryStorageConflictError("stale-initial-history-callback");
            },
            onCommitted: (committed) => {
              agent.providerHistory = committed.providerHistory;
              agent.persistence = committed.persistence ?? null;
              agent.runtimeInfo = committed.runtimeInfo;
              // The null-handle proof expires at the durable commit, even if runtime adoption fails.
              admitted = undefined;
              transition.adopt();
            },
          });
        } catch (error) {
          conflicted = true;
          throw error;
        }
      },
    };
    return context;
  }

  private freshRewindContext(agentId: string, operationId: string): ClaudeFreshRewindContext {
    let admitted: StoredAgentRecord | undefined;
    let conflicted = false;
    const context: ClaudeFreshRewindContext = {
      owner: {},
      operationId,
      get admission() {
        return admitted;
      },
      release: () => {
        if (!conflicted) admitted = undefined;
      },
      admit: async () => {
        if (conflicted)
          throw new HistoryStorageConflictError("fresh-admission-conflict-reload-required");
        const agent = this.host.requireSessionAgent(agentId);
        if (agent.session.claudeFreshRewind?.owner !== context.owner)
          throw new HistoryStorageConflictError("fresh-query-admission-conflict");
        await this.host.persistSnapshot(agent);
        const captured = await this.host.store().captureAdmission(agentId);
        const stillOwned =
          agent.session.claudeFreshRewind?.owner === context.owner &&
          captured.claudeFreshRewind?.operationId === operationId;
        const sameRoute =
          captured.provider === agent.provider &&
          sameHistoryStorage(
            captured.providerHistory?.storage ?? { kind: "unknown" },
            agent.session.historyStorage ?? { kind: "unknown" },
          );
        const sameRecoveryHandle = captured.persistence?.sessionId === agent.persistence?.sessionId;
        if (!stillOwned || !sameRoute || !sameRecoveryHandle)
          throw new HistoryStorageConflictError("fresh-query-admission-conflict");
        admitted = captured;
      },
      commit: async (transition) => {
        const agent = this.host.requireSessionAgent(agentId);
        if (
          agent.session.claudeFreshRewind?.owner !== context.owner ||
          !transition.next ||
          !admitted
        )
          throw new HistoryStorageConflictError("stale-fresh-rewind-callback");
        try {
          await this.commitRewindTransition(agent, admitted, transition, context);
        } catch (error) {
          conflicted = true;
          throw error;
        }
      },
    };
    return context;
  }

  private assertRewindTransition(
    agent: Agent,
    expected: StoredAgentRecord,
    transition: ClaudeRewindTransition,
    fresh: ClaudeFreshRewindContext | undefined,
  ): void {
    const binding = expected.providerHistory;
    const stillRegistered = this.host.isCurrent(agent);
    const registeredClaudeRoute =
      binding?.storage.kind === "configured-home" &&
      binding.storage.provider === "claude" &&
      binding.registration === "registered" &&
      sameHistoryStorage(binding.storage, transition.storage);
    const previousIsCanonicalHandle =
      !!expected.persistence &&
      expected.persistence.sessionId === binding?.sessionId &&
      samePersistenceHandle(
        expected.persistence,
        this.host.normalizePersistence(transition.previous, agent.config),
      ) &&
      transition.previous.provider === agent.provider;
    const freshStillOwned = !fresh || agent.session.claudeFreshRewind?.owner === fresh.owner;
    if (
      !stillRegistered ||
      !registeredClaudeRoute ||
      !previousIsCanonicalHandle ||
      !freshStillOwned
    )
      throw new HistoryStorageConflictError("rewind-canonical-handle-conflict");
  }

  /** Commit a Claude rewind's new handle (or fresh intent) and adopt it on the live agent. */
  async commitRewindTransition(
    agent: Agent,
    expected: StoredAgentRecord,
    transition: ClaudeRewindTransition,
    fresh?: ClaudeFreshRewindContext,
  ): Promise<void> {
    this.assertRewindTransition(agent, expected, transition, fresh);
    const next = transition.next
      ? (this.host.normalizePersistence(transition.next, agent.config) ?? undefined)
      : undefined;
    const pending = !next ? this.freshRewindContext(agent.id, randomUUID()) : undefined;
    try {
      await this.host.store().commitRewind({
        expected,
        next,
        freshOperationId: fresh?.operationId ?? pending?.operationId,
        assertCurrent: () => {
          transition.assertCurrent?.();
          if (
            !this.host.isCurrent(agent) ||
            (fresh && agent.session.claudeFreshRewind?.owner !== fresh.owner)
          )
            throw new HistoryStorageConflictError("stale-rewind-callback");
        },
        onCommitted: (record) => {
          agent.providerHistory = record.providerHistory;
          agent.persistence = record.persistence ?? null;
          agent.runtimeInfo = record.runtimeInfo;
          transition.adopt(pending);
        },
      });
    } catch (error) {
      if (error instanceof HistoryIdentityCommittedError) {
        if (fresh) {
          // This callback runs inside the query pump. Awaiting its own close would deadlock.
          // The canonical new handle is retained; the caller reports reload-required.
          agent.lastError =
            "Claude rewind identity committed; reload required after runtime adoption failed";
          throw error;
        }
        // Disk already owns the new identity. Retire this inconsistent runtime without another snapshot.
        await this.host.retireCommittedRuntime(agent);
      }
      throw error;
    }
  }
}
