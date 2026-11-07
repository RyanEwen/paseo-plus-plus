import type { AttentionCallbackReservation } from "./delegations.js";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { AgentAttentionOutcome } from "@getpaseo/protocol/messages";
import type {
  AgentAttentionContext,
  AgentAttentionLink,
  AgentAttentionPeer,
  AgentAttentionRequestQuery,
  AgentMessageAttention,
} from "@getpaseo/protocol/agent-attention";
import type {
  AgentSubscriber,
  AttentionState,
  LiveManagedAgent,
  ManagedAgent,
  SubscribeOptions,
} from "../agent-manager.js";
import type {
  AgentProvider,
  AgentRunOptions,
  AgentStreamEvent,
  AgentTimelineItem,
} from "../agent-sdk-types.js";
import type { AgentSnapshotOptions, AgentStorage, StoredAgentRecord } from "../agent-storage.js";
import {
  AgentAttentionObjectives,
  AttentionObjectiveError,
  type AttentionAdmission,
  type StoredAttentionObjectives,
} from "./objectives.js";
import { AttentionPermissionCompletion } from "./permission-completion.js";
import { isRemotePeer } from "./peers.js";
import { AttentionPresentation } from "./presentation.js";

/** Shown to the human when a blocked task's requesting agent is verified gone. */
export const REQUESTER_LOST_PERMISSION_MESSAGE =
  "This task needs permission, but its requesting agent is no longer available.";
export const REQUESTER_LOST_FAILURE_MESSAGE =
  "This task failed, but its requesting agent is no longer available.";

interface HumanAttentionClaim {
  agent: ManagedAgent;
  objectives: AgentAttentionObjectives;
  lease: symbol;
  reason: string;
  turnId: string | null;
  nextAttention: AttentionState;
  isCurrent: () => boolean;
}

/** Whether the claim's candidate was written, and whether it then committed in memory. */
interface HumanAttentionProgress {
  persistenceObserved: boolean;
  committed: boolean;
}

/**
 * The agent manager internals the attention coordinator drives. The manager supplies them as
 * closures over its own state; the coordinator never reaches into the manager otherwise.
 */
export interface AttentionCoordinatorHost {
  agents(): Map<string, LiveManagedAgent>;
  registry(): AgentStorage | undefined;
  logger(): Logger;
  runForegroundMutation<T>(agentId: string, operation: () => Promise<T>): Promise<T>;
  persistSnapshot(agent: ManagedAgent, options?: AgentSnapshotOptions): Promise<void>;
  emitState(agent: ManagedAgent, options?: { persist?: boolean }): void;
  subscribe(callback: AgentSubscriber, options?: SubscribeOptions): () => void;
  dispatchStoredAgentState(record: StoredAgentRecord): void;
  hasInFlightRun(agentId: string): boolean;
  requirePublicAgent(id: string): LiveManagedAgent;
  requireRegistry(): AgentStorage;
  broadcastAgentAttention(agent: ManagedAgent, reason: "finished" | "error" | "permission"): void;
  recordAndDispatchTimelineItem(
    agentId: string,
    item: AgentTimelineItem,
    provider: AgentProvider,
    turnId?: string,
    options?: { providerMessageId?: string },
  ): AgentStreamEvent;
  setAgentAttention(agent: ManagedAgent, reason: "finished" | "error"): void;
  trackBackgroundTask(task: Promise<void>): void;
  validateAgentId(agentId: string, source: string): string;
}

/**
 * Agent-aware attention for one agent manager: objective ledgers, delegated request outcomes and
 * callbacks, human escalation, permission completion and requester-loss checks. The manager
 * calls it from its lifecycle hooks and exposes its public operations unchanged.
 */
export class AgentAttentionCoordinator {
  readonly presentation = new AttentionPresentation();
  readonly permissionCompletions = new WeakMap<ManagedAgent, AttentionPermissionCompletion>();
  private serverId?: string;
  private resolveRemoteRequester?: (
    requester: AgentAttentionPeer,
  ) => Promise<"available" | "missing" | "unknown">;

  constructor(private readonly host: AttentionCoordinatorHost) {}

  /** Configure host-qualified requester checks without turning a transport failure into orphanhood. */
  setAttentionHost(input: {
    serverId: string;
    resolveRemoteRequester: (
      requester: AgentAttentionPeer,
    ) => Promise<"available" | "missing" | "unknown">;
  }): void {
    this.serverId = input.serverId;
    this.resolveRemoteRequester = input.resolveRemoteRequester;
    for (const agent of this.host.agents().values()) {
      agent.attentionObjectives?.bindHost(input.serverId);
    }
  }

  /** Return only the caller's own objective membership, without continuation capability tokens. */
  getAttentionObjectives(agentId: string): AgentAttentionContext {
    return (
      this.host.requirePublicAgent(agentId).attentionObjectives?.describe() ?? {
        activeObjectiveIds: [],
        objectives: [],
      }
    );
  }

  /** Host-qualified identity used only to bind attention evidence, never to authorize execution. */
  attentionRequester(agentId: string): AgentAttentionPeer {
    return { agentId, ...(this.serverId ? { serverId: this.serverId } : {}) };
  }

  /** Reserve an exact target outcome and recheck membership after persistence before forwarding it. */
  async reserveAttentionCallback(input: {
    agentId: string;
    peer: AgentAttentionPeer;
    link: AgentAttentionLink;
    outcome: AgentAttentionOutcome;
    deliveryId: string;
  }): Promise<AttentionCallbackReservation> {
    return this.host.runForegroundMutation(input.agentId, async () => {
      const agent = this.host.requirePublicAgent(input.agentId);
      const ledger = agent.attentionObjectives;
      if (!ledger) {
        throw new AttentionObjectiveError(input.link.objectiveId);
      }
      const reservation = { ...input, requester: this.attentionRequester(input.agentId) };
      const result = ledger.reserveCallback(reservation);
      try {
        await this.host.persistSnapshot(agent);
        // Terminal events can close an objective while a storage write is pending.
        if (agent.attentionObjectives !== ledger)
          throw new AttentionObjectiveError(input.link.objectiveId);
        if (result.status === "reserved")
          ledger.assertCallbackReservation({
            ...input,
            outcomeId: input.outcome.id,
            lease: result.lease,
          });
        return result;
      } catch (error) {
        // No enqueue can have happened yet. Roll back this owner's claim even when the write throws.
        // A write that reached disk before failing is recoverable by an exact watcher after restart.
        if (result.status === "reserved") {
          try {
            ledger.releaseCallback({ ...input, lease: result.lease });
          } catch (releaseError) {
            if (!(releaseError instanceof AttentionObjectiveError)) {
              throw releaseError;
            }
          }
        }
        throw error;
      }
    });
  }

  /** A failed source write must leave target evidence unacknowledged and available for retry. */
  async persistAttentionDelivery(agentId: string): Promise<void> {
    await this.host.runForegroundMutation(agentId, async () => {
      this.host.requireRegistry();
      await this.host.persistSnapshot(this.host.requirePublicAgent(agentId));
    });
  }

  async releaseAttentionCallback(input: {
    agentId: string;
    peer: AgentAttentionPeer;
    link: AgentAttentionLink;
    deliveryId: string;
    lease: symbol;
  }): Promise<void> {
    await this.host.runForegroundMutation(input.agentId, async () => {
      const agent = this.host.requirePublicAgent(input.agentId);
      try {
        agent.attentionObjectives?.releaseCallback(input);
      } catch (error) {
        if (!(error instanceof AttentionObjectiveError)) {
          throw error;
        }
      }
      await this.host.persistSnapshot(agent);
    });
  }

  /** Persist this submission's rejection without inventing a provider acceptance or changing other jobs. */
  async recordAttentionRejection(input: {
    agentId: string;
    admissions: readonly AttentionAdmission[];
    error: string;
  }): Promise<void> {
    await this.host.runForegroundMutation(input.agentId, async () => {
      const agent = this.host.agents().get(input.agentId);
      if (agent) {
        agent.attentionObjectives ??= this.createAttentionObjectives(undefined);
        agent.attentionObjectives.requests.reject(input.admissions, input.error);
        await this.host.persistSnapshot(agent);
        this.host.emitState(agent, { persist: false });
        return;
      }
      const registry = this.host.registry();
      if (!registry || !(await registry.get(input.agentId))) {
        return;
      }
      await registry.update(input.agentId, (record) => {
        const ledger = this.createAttentionObjectives(record.attentionObjectives);
        ledger.requests.reject(input.admissions, input.error);
        return { ...record, attentionObjectives: ledger.snapshot() };
      });
      const updated = await registry.get(input.agentId);
      if (updated) {
        this.host.dispatchStoredAgentState(updated);
      }
    });
  }

  /**
   * Wait for one immutable request outcome under the caller's existing agent observation authority.
   *
   * Resolves null when no outcome can arrive: the request is known without one, or it is unknown
   * and no unadmitted run could still accept it (for example a deleted child or a lost prompt).
   */
  async waitForAttentionOutcome(input: {
    agentId: string;
    query: AgentAttentionRequestQuery;
    signal: AbortSignal;
    waitForSubmission?: boolean;
  }): Promise<AgentAttentionOutcome | null> {
    const changes = this.watchAgentChanges(input.agentId, input.signal);
    let query = input.query;
    try {
      for (;;) {
        input.signal.throwIfAborted();
        const seen = changes.version();
        const state = await this.host.runForegroundMutation(input.agentId, () =>
          this.readAttentionOutcome(input.agentId, query),
        );
        const wasAcknowledgement = query.acknowledgeOutcomeId !== undefined;
        query = { link: query.link, requester: query.requester };
        if (state.outcome) {
          return state.outcome;
        }
        // A deleted child, or one whose queued submission was lost, never admits the request.
        const awaitingSubmission =
          input.waitForSubmission === true && !wasAcknowledgement && state.submissionPossible;
        if (!state.pending && (state.known || !awaitingSubmission)) {
          return null;
        }
        await changes.after(seen);
      }
    } finally {
      changes.close();
    }
  }

  /**
   * Read (and, for an acknowledgement query, consume) one request's outcome from the live or
   * stored ledger. Runs inside the agent's foreground mutation lane.
   */
  private async readAttentionOutcome(agentId: string, query: AgentAttentionRequestQuery) {
    const agent = this.host.agents().get(agentId);
    // Only a run that has not been admitted yet can still accept this request.
    const submissionPossible = this.host.hasInFlightRun(agentId);
    if (agent?.attentionObjectives) {
      const result = agent.attentionObjectives.requests.read(query);
      if (query.acknowledgeOutcomeId) {
        await this.host.persistSnapshot(agent);
      }
      return { ...result, submissionPossible };
    }
    const registry = this.host.registry();
    const record = await registry?.get(agentId);
    if (!registry || !record?.attentionObjectives) {
      return { outcome: null, pending: false, known: false, submissionPossible };
    }
    if (query.acknowledgeOutcomeId) {
      await registry.update(agentId, (current) => {
        const ledger = this.createAttentionObjectives(current.attentionObjectives);
        ledger.requests.read(query);
        return { ...current, attentionObjectives: ledger.snapshot() };
      });
    }
    const latest = await registry.get(agentId);
    const result = this.createAttentionObjectives(latest?.attentionObjectives).requests.read({
      link: query.link,
      requester: query.requester,
    });
    return { ...result, submissionPossible };
  }

  /**
   * Count change events for one agent so a waiter can sleep until something changed after the
   * state it last read. `after(seen)` resolves at once if a change already arrived, and on abort.
   */
  private watchAgentChanges(agentId: string, signal: AbortSignal) {
    let changed = 0;
    let wake: (() => void) | undefined;
    const unsubscribe = this.host.subscribe(
      () => {
        changed += 1;
        wake?.();
      },
      { agentId, replayState: false },
    );
    const abort = () => wake?.();
    signal.addEventListener("abort", abort, { once: true });
    return {
      version: () => changed,
      after: async (seen: number): Promise<void> => {
        await new Promise<void>((resume) => {
          wake = resume;
          if (signal.aborted || seen !== changed) {
            resume();
          }
        });
        wake = undefined;
      },
      close: () => {
        unsubscribe();
        signal.removeEventListener("abort", abort);
      },
    };
  }

  get agentAwareAttentionEnabled(): boolean {
    return this.presentation.agentAware;
  }

  /** Apply or roll back host config without marking unread, persisting agent state or replaying events. */
  setAttentionPresentationEnabled(enabled: boolean): void {
    this.presentation.setAgentAware(enabled);
  }

  createAttentionObjectives(stored?: StoredAttentionObjectives): AgentAttentionObjectives {
    return this.presentation.attach(new AgentAttentionObjectives(stored, this.serverId));
  }

  /** Approval continues its original objective rather than creating a human-owned request. */
  captureAttentionContinuation(agentId: string): AttentionAdmission | undefined {
    const ledger = this.host.requirePublicAgent(agentId).attentionObjectives;
    return ledger?.isAudienceKnown ? ledger.capture() : undefined;
  }

  assertAttentionAdmission(agent: ManagedAgent, options: AgentRunOptions | undefined): void {
    const inputs = options?.attention ?? [];
    if (agent.attentionObjectives) {
      agent.attentionObjectives.assertAdmissions(inputs);
    } else if (
      inputs.some(
        (input) =>
          input.kind === "continuation" ||
          (input.kind === "agent" && input.attention?.continuation),
      )
    ) {
      throw new AttentionObjectiveError("unknown continuation");
    }
  }

  /** Persist a recipient-bound continuation before an agent's outgoing message can be dispatched. */
  async prepareAttentionMessage(input: {
    agentId: string;
    recipient: AgentAttentionPeer;
    objectiveId?: string;
    expectedTurnId?: string | null;
    requestId?: string;
  }): Promise<AgentMessageAttention | undefined> {
    const agent = this.host.requirePublicAgent(input.agentId);
    const expectedTurnId =
      input.expectedTurnId === undefined ? agent.activeTurnId : input.expectedTurnId;
    return this.host.runForegroundMutation(agent.id, async () => {
      if (agent.activeTurnId !== expectedTurnId) {
        throw new AttentionObjectiveError("outgoing request from a retired turn");
      }
      const attention = agent.attentionObjectives?.outgoing({
        recipient: input.recipient,
        objectiveId: input.objectiveId,
        requestId: input.requestId,
      });
      if (attention) {
        await this.host.persistSnapshot(agent);
      }
      return attention;
    });
  }

  /** Explicit waiting/final intent is restricted to objectives in this accepted provider turn. */
  async reportObjectiveStatus(input: {
    agentId: string;
    objectiveId: string;
    disposition: "waiting" | "final";
  }): Promise<AgentAttentionContext> {
    const agent = this.host.requirePublicAgent(input.agentId);
    const expectedTurnId = agent.activeTurnId;
    return this.host.runForegroundMutation(agent.id, async () => {
      if (!expectedTurnId || agent.activeTurnId !== expectedTurnId || !agent.attentionObjectives) {
        throw new AttentionObjectiveError(input.objectiveId);
      }
      agent.attentionObjectives.declare(input.objectiveId, input.disposition);
      await this.host.persistSnapshot(agent);
      this.host.emitState(agent, { persist: false });
      return agent.attentionObjectives.describe();
    });
  }

  /** Request human review for the caller's current objective and keep the stated reason in its chat. */
  async requestHumanAttention(input: {
    agentId: string;
    objectiveId: string;
    reason: string;
  }): Promise<{ notified: boolean }> {
    const agent = this.host.requirePublicAgent(input.agentId);
    const expectedTurnId = agent.activeTurnId;
    return this.host.runForegroundMutation(agent.id, async () => {
      if (!expectedTurnId || agent.activeTurnId !== expectedTurnId || !agent.attentionObjectives) {
        throw new AttentionObjectiveError(input.objectiveId);
      }
      return {
        notified: await this.raiseHumanAttention({
          agent,
          objectiveId: input.objectiveId,
          reason: input.reason,
        }),
      };
    });
  }

  /** Persist and publish one owned claim inside the caller's existing foreground mutation lane. */
  async raiseHumanAttention(input: {
    agent: ManagedAgent;
    objectiveId: string;
    reason: string;
    isCurrent?: () => boolean;
  }): Promise<boolean> {
    const claim = this.reserveHumanClaim(input);
    if (!claim) {
      return false;
    }
    const progress: HumanAttentionProgress = { persistenceObserved: false, committed: false };
    try {
      await this.persistHumanClaim(claim, progress);
    } catch (error) {
      return this.recoverHumanClaimFailure(claim, progress, error);
    }
    if (progress.committed) {
      return true;
    }
    claim.objectives.releaseHumanAttention(claim.lease);
    await this.repairRetiredHumanAttention(claim.agent.id);
    throw new AttentionObjectiveError(input.objectiveId);
  }

  /**
   * Reserve one human escalation reason for the objective, or null when the agent has no ledger
   * or the same reason is already announced or pending. The claim stays current only while the
   * agent, ledger, turn, attention state and reservation are the ones captured here.
   */
  private reserveHumanClaim(input: {
    agent: ManagedAgent;
    objectiveId: string;
    reason: string;
    isCurrent?: () => boolean;
  }): HumanAttentionClaim | null {
    const { agent, objectiveId, reason } = input;
    const objectives = agent.attentionObjectives;
    if (!objectives) {
      return null;
    }
    this.host.requireRegistry();
    const lease = objectives.reserveHumanAttention(objectiveId, reason);
    if (!lease) {
      return null;
    }
    const turnId = agent.activeTurnId;
    const previousAttention = agent.attention;
    const previousMessage = agent.attentionMessage;
    const isCurrent = () =>
      this.host.agents().get(agent.id) === agent &&
      agent.attentionObjectives === objectives &&
      agent.activeTurnId === turnId &&
      agent.attention === previousAttention &&
      agent.attentionMessage === previousMessage &&
      objectives.isHumanAttentionReservationCurrent(lease) &&
      (input.isCurrent === undefined || input.isCurrent());
    return {
      agent,
      objectives,
      lease,
      reason,
      turnId,
      nextAttention: {
        requiresAttention: true,
        attentionReason: "finished",
        attentionTimestamp: new Date(),
      },
      isCurrent,
    };
  }

  /**
   * Write the claim's candidate through the storage queue and commit it in memory once written.
   * Resolving and publishing inside the writer keeps an intervening ordinary projection from
   * erasing the saved reason; later chat updates keep their normal persistence path.
   */
  private async persistHumanClaim(
    claim: HumanAttentionClaim,
    progress: HumanAttentionProgress,
  ): Promise<void> {
    const { agent, objectives, lease, reason, turnId, nextAttention, isCurrent } = claim;
    await this.host.persistSnapshot(agent, {
      operation: {
        resolveSnapshot: () => {
          if (!isCurrent()) {
            return null;
          }
          return {
            ...agent,
            attention: nextAttention,
            attentionMessage: reason,
            attentionObjectives: objectives.humanAttentionCandidate(lease),
          };
        },
        onCommitted: () => {
          // The candidate was written even if its owner retired before this callback.
          progress.persistenceObserved = true;
          if (!isCurrent()) {
            return;
          }
          objectives.commitHumanAttention(lease);
          agent.attention = nextAttention;
          agent.attentionMessage = reason;
          // Establish business success before any observer can fail or mutate newer state.
          progress.committed = true;
          this.publishHumanAttention({ agent, reason, turnId });
        },
      },
    });
  }

  /**
   * A storage failure after commit only loses the acknowledgement, so the escalation stands.
   * Otherwise release the claim, repair a written-but-retired candidate, and rethrow.
   */
  private async recoverHumanClaimFailure(
    claim: HumanAttentionClaim,
    progress: HumanAttentionProgress,
    error: unknown,
  ): Promise<boolean> {
    if (progress.committed) {
      this.host
        .logger()
        .warn(
          { err: error, agentId: claim.agent.id },
          "Storage acknowledgement failed after human attention committed",
        );
      return true;
    }
    claim.objectives.releaseHumanAttention(claim.lease);
    if (progress.persistenceObserved) {
      try {
        await this.repairRetiredHumanAttention(claim.agent.id);
      } catch (repairError) {
        // AggregateError keeps the repair failure as its cause; both failures stay in `errors`.
        const combinedFailure = new AggregateError(
          [error, repairError],
          "Human attention acknowledgement and retired candidate repair failed",
          { cause: repairError },
        );
        throw combinedFailure;
      }
    }
    throw error;
  }

  /** Repair a retired candidate from the instance current when the queue runs, never an old copy. */
  async repairRetiredHumanAttention(agentId: string): Promise<void> {
    const current = this.host.agents().get(agentId);
    if (!current) {
      return;
    }
    await this.host.persistSnapshot(current, {
      operation: { resolveSnapshot: () => this.host.agents().get(agentId) ?? null },
    });
  }

  /** Attempt each synchronous observer after commit; none can roll back or poison the writer. */
  publishHumanAttention(input: {
    agent: ManagedAgent;
    reason: string;
    turnId: string | null;
  }): void {
    const { agent, reason, turnId } = input;
    const phases = [
      {
        name: "timeline",
        publish: () =>
          this.host.recordAndDispatchTimelineItem(
            agent.id,
            {
              type: "tool_call",
              callId: `human-attention-${randomUUID()}`,
              name: "request_human_attention",
              status: "completed",
              error: null,
              detail: { type: "plain_text", text: reason },
            },
            agent.provider,
            turnId ?? undefined,
          ),
      },
      { name: "state", publish: () => this.host.emitState(agent, { persist: false }) },
      {
        name: "notification",
        publish: () =>
          this.host.broadcastAgentAttention({ ...agent, attentionMessage: reason }, "finished"),
      },
    ];
    for (const phase of phases) {
      try {
        phase.publish();
      } catch (error) {
        this.host
          .logger()
          .error(
            { err: error, agentId: agent.id, phase: phase.name },
            "Human attention observer failed after durable commit",
          );
      }
    }
  }

  admitAttention(input: {
    agent: ManagedAgent;
    options?: AgentRunOptions;
    steering: boolean;
    turnId?: string;
    accepted?: boolean;
  }): void {
    const { agent, options, steering } = input;
    agent.attentionObjectives ??= this.createAttentionObjectives(undefined);
    const admissions: readonly AttentionAdmission[] = options?.attention ?? [
      { kind: "human", requestId: options?.clientMessageId ?? randomUUID() },
    ];
    const acceptedTurnId = input.accepted === false ? undefined : input.turnId;
    let rebindSteer: (() => boolean) | undefined;
    if (steering && acceptedTurnId) {
      rebindSteer = this.permissionCompletions
        .get(agent)
        ?.prepareSteerAdmission(agent.attentionObjectives, acceptedTurnId);
    }
    agent.attentionObjectives.admit({
      inputs: admissions,
      steering: steering,
      acceptance: {
        turnId: input.turnId,
        accepted: input.accepted,
      },
    });
    // Steer admission and its scope renewal are synchronous; no terminal can enter between them.
    if (rebindSteer?.() !== true) {
      this.retirePermissionCompletion(agent);
      if (acceptedTurnId) {
        this.createPermissionCompletion(agent, agent.attentionObjectives, acceptedTurnId);
      }
    }
    agent.attentionTerminal = undefined;
  }

  /** Bind a new SDK turn so old response markers cannot suppress its accepted final. */
  createPermissionCompletion(
    agent: ManagedAgent,
    objectives: AgentAttentionObjectives,
    turnId: string,
  ): AttentionPermissionCompletion {
    const completion = new AttentionPermissionCompletion(
      objectives,
      turnId,
      () =>
        this.host.agents().get(agent.id) === agent &&
        agent.attentionObjectives === objectives &&
        !agent.pendingReplacement,
    );
    this.permissionCompletions.set(agent, completion);
    return completion;
  }

  /** Bind permission classification to the actual accepted checkpoint, not the latest idle edge. */
  observePermissionCompletion(agent: ManagedAgent, turnId: string, permissionId: string): void {
    const objectives = agent.attentionObjectives;
    if (!objectives?.isAudienceKnown) {
      return;
    }
    const completion = this.permissionCompletions.get(agent);
    if (completion?.matches(objectives, turnId)) {
      completion.observePermission(permissionId);
    }
  }

  /** Retire held response/terminal identities before a new admission or committed lifecycle change. */
  retirePermissionCompletion(agent: ManagedAgent): void {
    this.permissionCompletions.get(agent)?.retire();
    this.permissionCompletions.delete(agent);
  }

  /** Publish a reconciled real terminal even when its natural idle edge already passed. */
  reconcilePermissionCompletion(
    agent: ManagedAgent,
    completion: AttentionPermissionCompletion,
  ): void {
    if (this.permissionCompletions.get(agent) !== completion) {
      return;
    }
    const notifyHuman = completion.reconcile(agent.pendingPermissions.size);
    if (notifyHuman === undefined) {
      return;
    }
    agent.attentionTerminal = undefined;
    if (notifyHuman || !this.presentation.agentAware)
      this.host.setAgentAttention(agent, "finished");
    this.host.emitState(agent);
  }

  /** Reuse original blocker ownership for initial checks and committed local lifecycle loss. */
  checkOrphanedAttention(agent: ManagedAgent, lostLocalRequesters?: ReadonlySet<string>): void {
    const objectives = agent.attentionObjectives;
    if (!objectives || agent.internal) {
      return;
    }
    const task = objectives.blockers
      .verify({
        lostLocalRequesters,
        resolveRequester: (requester) => this.resolveAttentionRequester(requester),
        isCurrent: (checkpoint) => {
          const sameOwner =
            this.host.agents().get(agent.id) === agent &&
            agent.attentionObjectives === objectives &&
            !agent.pendingReplacement;
          const stillBlocked =
            checkpoint.reason === "error"
              ? agent.lifecycle === "error"
              : agent.pendingPermissions.has(checkpoint.permissionId);
          return sameOwner && stillBlocked;
        },
        escalate: async ({ objectiveId, reason, isCurrent }) => {
          const message =
            reason === "permission"
              ? REQUESTER_LOST_PERMISSION_MESSAGE
              : REQUESTER_LOST_FAILURE_MESSAGE;
          await this.host.runForegroundMutation(agent.id, async () => {
            // A foreground write may retire the exact checkpoint while this lane is held.
            if (!isCurrent()) {
              return;
            }
            await this.raiseHumanAttention({ agent, objectiveId, reason: message, isCurrent });
          });
        },
      })
      .catch((error) => {
        this.host
          .logger()
          .warn({ error, agentId: agent.id }, "Could not verify requesting agent availability");
      });
    this.host.trackBackgroundTask(task);
  }

  /** Unknown routes and resumable local runtimes are not proof of requester loss. */
  async resolveAttentionRequester(
    requester: AgentAttentionPeer,
  ): Promise<"available" | "missing" | "unknown"> {
    if (isRemotePeer(requester, this.serverId)) {
      return this.resolveRemoteRequester ? this.resolveRemoteRequester(requester) : "unknown";
    }
    // Opaque transport sender IDs cannot be used as unchecked local storage addresses.
    try {
      this.host.validateAgentId(requester.agentId, "attentionRequester");
    } catch {
      return "unknown";
    }
    const record = await this.host.registry()?.get(requester.agentId);
    if (record) {
      return record.archivedAt ? "missing" : "available";
    }
    if (this.host.agents().has(requester.agentId)) {
      return "available";
    }
    return this.host.registry() ? "missing" : "unknown";
  }
}
