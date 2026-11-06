import { AgentAttentionRequests, StoredAttentionRequestsSchema } from "./requests.js";
import {
  AttentionBlockers,
  StoredAttentionBlockersSchema,
  type AttentionBlockerMember,
} from "./blockers.js";
import type { AgentAttentionOutcome } from "@getpaseo/protocol/messages";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AgentAttentionLinkSchema,
  AgentAttentionPeerSchema,
  AgentObjectiveAudienceSchema,
  type AgentAttentionLink,
  type AgentAttentionObjectives as AgentAttentionDescription,
  type AgentAttentionPeer,
  type AgentMessageAttention,
} from "@getpaseo/protocol/agent-attention";

const objectiveSchema = z.object({
  id: z.string(),
  audience: AgentObjectiveAudienceSchema,
  disposition: z.enum(["normal", "waiting", "final"]),
  replyTo: AgentAttentionLinkSchema.nullable(),
  announcedReasons: z.array(z.string()),
});

export const StoredAttentionObjectivesSchema = z.object({
  admissionId: z.string().optional(),
  audienceKnown: z.boolean().optional(),
  requests: StoredAttentionRequestsSchema.optional(),
  blockers: StoredAttentionBlockersSchema.optional(),
  objectives: z.array(objectiveSchema),
  activeObjectiveIds: z.array(z.string()),
  delegations: z.array(
    z.object({
      objectiveId: z.string(),
      token: z.string(),
      requestId: z.string(),
      acceptedMessageIds: z.array(z.string()).optional(),
      deliveries: z
        .array(
          z.object({
            outcomeId: z.string(),
            deliveryId: z.string(),
            status: z.enum(["reserved", "consumed"]),
          }),
        )
        .optional(),
      recipient: AgentAttentionPeerSchema,
    }),
  ),
});
export type StoredAttentionObjectives = z.infer<typeof StoredAttentionObjectivesSchema>;
type AttentionObjective = z.infer<typeof objectiveSchema>;
type CallbackDelivery = NonNullable<
  StoredAttentionObjectives["delegations"][number]["deliveries"]
>[number];

interface HumanAttentionReservation {
  objective: AttentionObjective;
  reason: string;
}

/** A lease belongs to one live watcher and is deliberately absent from persisted and wire state. */
export type AttentionCallbackReservation =
  | { status: "reserved"; lease: symbol }
  | { status: "consumed" };

export type AttentionAdmission =
  | { kind: "human"; requestId: string }
  | {
      kind: "agent";
      requestId: string;
      requester: AgentAttentionPeer;
      attention?: AgentMessageAttention;
    }
  | { kind: "continuation"; objectiveIds: readonly string[]; admissionId: string };

export class AttentionObjectiveError extends Error {
  constructor(readonly objectiveId: string) {
    super(`Objective ${objectiveId} does not belong to this accepted turn`);
    this.name = "AttentionObjectiveError";
  }
}

/**
 * Owns output audience independently of provider turns and lifecycle parentage.
 * Admission is called only after provider acceptance, under the manager's turn fence.
 */
export class AgentAttentionObjectives {
  readonly requests: AgentAttentionRequests;
  readonly blockers: AttentionBlockers;
  private readonly state: StoredAttentionObjectives & { admissionId: string };
  private readonly callbackOwners = new WeakMap<CallbackDelivery, symbol>();
  private readonly humanAttentionOwners = new Map<symbol, HumanAttentionReservation>();

  constructor(
    stored?: StoredAttentionObjectives,
    private localServerId?: string,
  ) {
    const state = stored
      ? structuredClone(stored)
      : { objectives: [], activeObjectiveIds: [], delegations: [] };
    this.state = {
      ...state,
      audienceKnown: stored?.audienceKnown ?? stored !== undefined,
      admissionId: stored?.admissionId ?? randomUUID(),
    };
    this.requests = new AgentAttentionRequests(stored?.requests, localServerId);
    this.blockers = new AttentionBlockers(
      stored?.blockers,
      (ids) => this.captureBlockerMembers(ids),
      localServerId,
    );
  }

  get isAudienceKnown(): boolean {
    return this.state.audienceKnown === true;
  }

  /** Persist the ledger without sharing mutable objects with the storage queue. */
  snapshot(): StoredAttentionObjectives {
    const snapshot: StoredAttentionObjectives = {
      ...structuredClone(this.state),
      requests: this.requests.snapshot(),
    };
    const blockers = this.blockers.snapshot();
    if (blockers.length > 0) snapshot.blockers = blockers;
    else delete snapshot.blockers;
    return snapshot;
  }

  /** Qualify local peers without replacing objective, terminal, response or lease owners. */
  bindHost(localServerId: string): void {
    this.localServerId = localServerId;
    this.requests.bindHost(localServerId);
    this.blockers.bindHost(localServerId);
  }

  /** Public context contains objective membership, never reply capability tokens. */
  describe(): AgentAttentionDescription {
    return {
      activeObjectiveIds: [...this.state.activeObjectiveIds],
      objectives: this.state.objectives.map(({ id, audience, disposition }) => ({
        id,
        audience: structuredClone(audience),
        disposition,
      })),
    };
  }

  /** Admit accepted inputs. Steering joins current obligations rather than replacing their audience. */
  admit({
    inputs,
    steering = false,
    acceptance,
  }: {
    inputs: readonly AttentionAdmission[];
    steering?: boolean;
    acceptance?: { turnId?: string; accepted?: boolean };
  }): void {
    this.assertAdmissions(inputs);
    const memberships = new Map<string, string>();
    const admittedIds = inputs.flatMap((input) => {
      const ids = this.admitInput(input);
      if (input.kind === "agent" && ids[0]) memberships.set(input.requestId, ids[0]);
      return ids;
    });
    if (acceptance?.accepted !== false) {
      for (const input of inputs) {
        if (input.kind !== "agent" || !input.attention?.continuation) continue;
        const delegation = this.findDelegation(input.attention.continuation, input.requester);
        (delegation.acceptedMessageIds ??= []).push(input.requestId);
        const delivery = delegation.deliveries?.find(
          (entry) => entry.deliveryId === input.requestId,
        );
        if (delivery) {
          delivery.status = "consumed";
          this.callbackOwners.delete(delivery);
        }
      }
    }
    if (acceptance?.turnId)
      this.requests.accept({
        admissions: inputs,
        turnId: acceptance.turnId,
        steering,
        objectives: memberships,
      });
    const previousIds = steering ? this.state.activeObjectiveIds : [];
    this.state.activeObjectiveIds = [...new Set([...previousIds, ...admittedIds])];
    this.state.admissionId = randomUUID();
    this.state.audienceKnown = true;
    this.blockers.admit({
      turnId: acceptance?.accepted === false ? undefined : acceptance?.turnId,
      steering,
    });
  }

  /** Capture continuation membership before a permission response can settle its provider turn. */
  capture(): Extract<AttentionAdmission, { kind: "continuation" }> {
    return {
      kind: "continuation",
      objectiveIds: [...this.state.activeObjectiveIds],
      admissionId: this.state.admissionId,
    };
  }

  /** A delayed permission response cannot replace work admitted after its original request. */
  assertContinuation(input: Extract<AttentionAdmission, { kind: "continuation" }>): void {
    if (input.admissionId !== this.state.admissionId) {
      throw new AttentionObjectiveError("retired permission continuation");
    }
    for (const id of input.objectiveIds) this.requireActiveObjective(id);
  }

  /** Claimed continuations must validate before any provider or objective mutation. */
  assertAdmissions(inputs: readonly AttentionAdmission[]): void {
    for (const input of inputs) {
      if (input.kind === "continuation") this.assertContinuation(input);
      if (input.kind === "agent" && input.attention?.continuation)
        this.resolveAgentContinuation(input);
      if (
        input.kind === "agent" &&
        input.attention?.requesterObjective &&
        input.attention.requesterObjective.requestId !== input.requestId
      )
        throw new AttentionObjectiveError("request identity mismatch");
      if (
        input.kind !== "continuation" &&
        !(input.kind === "agent" && input.attention?.continuation)
      ) {
        const existing = this.state.objectives.find((entry) => entry.id === input.requestId);
        if (
          existing &&
          (existing.audience.kind !== input.kind ||
            (existing.audience.kind === "agent" &&
              input.kind === "agent" &&
              !this.samePeer(existing.audience.requester, input.requester)))
        )
          throw new AttentionObjectiveError("request identity belongs to another audience");
      }
    }
  }

  /** Only an actual human obligation in this accepted turn can produce automatic human completion. */
  hasHumanAudience(): boolean {
    return this.activeObjectives().some((objective) => objective.audience.kind === "human");
  }

  /** Unread is explicit human intent; a problem otherwise follows this turn's actual audience. */
  requiresHumanAttention(input: { hasUnread: boolean; hasProblem: boolean }): boolean | undefined {
    if (!this.isAudienceKnown) return undefined;
    return input.hasUnread || (input.hasProblem && this.hasHumanAudience());
  }

  /** Finish ordinary objectives; explicitly waiting objectives survive later turns and restarts. */
  finish(): boolean {
    const active = this.activeObjectives();
    const notifyHuman = active.some(
      (objective) => objective.audience.kind === "human" && objective.disposition !== "waiting",
    );
    const completed = new Set(
      active.filter((objective) => objective.disposition !== "waiting").map(({ id }) => id),
    );
    this.state.objectives = this.state.objectives.filter(({ id }) => !completed.has(id));
    this.state.delegations = this.state.delegations.filter(
      ({ objectiveId }) => !completed.has(objectiveId),
    );
    this.state.activeObjectiveIds = this.state.activeObjectiveIds.filter(
      (id) => !completed.has(id),
    );
    return notifyHuman;
  }

  /** Declare intent for a member of this accepted turn, not an unrelated outstanding objective. */
  declare(objectiveId: string, disposition: "waiting" | "final"): void {
    this.requireActiveObjective(objectiveId).disposition = disposition;
  }

  /** Return false for a retry of the same reason, including after an attention clear or restart. */
  requestHuman(objectiveId: string, reason: string): boolean {
    const lease = this.reserveHumanAttention(objectiveId, reason);
    if (!lease) return false;
    this.commitHumanAttention(lease);
    return true;
  }

  /** Keep pending reasons process-local so ordinary close/reload snapshots cannot commit them. */
  reserveHumanAttention(objectiveId: string, reason: string): symbol | null {
    const objective = this.requireActiveObjective(objectiveId);
    const pending = [...this.humanAttentionOwners.values()].some(
      (owner) => owner.objective === objective && owner.reason === reason,
    );
    if (objective.announcedReasons.includes(reason) || pending) {
      return null;
    }
    const lease = Symbol("human attention owner");
    this.humanAttentionOwners.set(lease, { objective, reason });
    return lease;
  }

  /**
   * Freeze the exact claim for its candidate write without adding it to ordinary live snapshots.
   * Storage projects snapshots lazily, so this detached ledger must own the candidate reason.
   */
  humanAttentionCandidate(lease: symbol): AgentAttentionObjectives {
    const owner = this.humanAttentionOwners.get(lease);
    if (!owner || !this.isHumanAttentionReservationCurrent(lease)) {
      throw new AttentionObjectiveError("retired human attention claim");
    }
    const snapshot = this.snapshot();
    const objective = snapshot.objectives[this.state.objectives.indexOf(owner.objective)];
    if (!objective) throw new AttentionObjectiveError(owner.objective.id);
    objective.announcedReasons.push(owner.reason);
    return new AgentAttentionObjectives(snapshot, this.localServerId);
  }

  /** A reused string ID cannot make a retired objective's in-flight announcement current again. */
  isHumanAttentionReservationCurrent(lease: symbol): boolean {
    const reservation = this.humanAttentionOwners.get(lease);
    return reservation !== undefined && this.activeObjectives().includes(reservation.objective);
  }

  /** Commit only the exact owned objective's reason after persistence and current-attempt checks. */
  commitHumanAttention(lease: symbol): void {
    const owner = this.humanAttentionOwners.get(lease);
    if (!owner) return;
    owner.objective.announcedReasons.push(owner.reason);
    this.humanAttentionOwners.delete(lease);
  }

  /** Release only the failed process-local claim; no ordinary or restored ledger needs rollback. */
  releaseHumanAttention(lease: symbol): void {
    this.humanAttentionOwners.delete(lease);
  }

  /** Current agent recipients are used only for verified requester-unavailability checks. */
  requesters(): AgentAttentionPeer[] {
    return this.activeObjectives().flatMap((objective) =>
      objective.audience.kind === "agent" ? [objective.audience.requester] : [],
    );
  }

  /**
   * Bind an outgoing request to its recipient and the caller's current objective.
   * Explicit reports to the original requester carry the original reply capability too.
   */
  outgoing({
    recipient,
    objectiveId,
    requestId = randomUUID(),
  }: {
    recipient: AgentAttentionPeer;
    objectiveId?: string;
    requestId?: string;
  }): AgentMessageAttention | undefined {
    const active = this.activeObjectives();
    if (!objectiveId && active.length > 1) {
      throw new AttentionObjectiveError(
        "Specify objectiveId when this turn contains multiple requests",
      );
    }
    const objective = objectiveId ? this.requireActiveObjective(objectiveId) : active[0];
    if (!objective) {
      return undefined;
    }
    let delegation = this.state.delegations.find(
      (entry) =>
        entry.requestId === requestId &&
        entry.objectiveId === objective.id &&
        this.samePeer(entry.recipient, recipient),
    );
    if (!delegation) {
      delegation = {
        objectiveId: objective.id,
        token: randomUUID(),
        requestId,
        recipient: structuredClone(recipient),
      };
      this.state.delegations.push(delegation);
    }
    const requesterObjective = { objectiveId: objective.id, token: delegation.token, requestId };
    const isReply =
      objective.audience.kind === "agent" && this.samePeer(objective.audience.requester, recipient);
    if (isReply && objective.replyTo) {
      return { requesterObjective, continuation: objective.replyTo };
    }
    return { requesterObjective };
  }

  /**
   * Reserve an immutable outcome for one exact callback message before enqueueing it.
   * A restored unconsumed reservation has no live owner and can be reacquired only for its original message.
   */
  reserveCallback(input: {
    link: AgentAttentionLink;
    peer: AgentAttentionPeer;
    requester: AgentAttentionPeer;
    outcome: AgentAttentionOutcome;
    deliveryId: string;
  }): AttentionCallbackReservation {
    const delegation = this.findDelegation(input.link, input.peer);
    if (
      (input.outcome.kind === "rejected") !== (input.outcome.acceptedTurnId === null) ||
      (input.outcome.kind === "permission" && !input.outcome.permission)
    )
      throw new AttentionObjectiveError("invalid request outcome evidence");
    if (
      input.outcome.requestId !== input.link.requestId ||
      !this.samePeer(input.requester, input.outcome.requester)
    )
      throw new AttentionObjectiveError("outcome identity mismatch");
    const deliveries = (delegation.deliveries ??= []);
    const existing = deliveries.find((entry) => entry.outcomeId === input.outcome.id);
    if (existing) {
      if (existing.deliveryId !== input.deliveryId)
        throw new AttentionObjectiveError("outcome message identity changed");
      if (existing.status === "consumed") return { status: "consumed" };
      if (this.callbackOwners.has(existing))
        throw new AttentionObjectiveError("outcome already reserved");
    }
    const delivery = existing ?? {
      outcomeId: input.outcome.id,
      deliveryId: input.deliveryId,
      status: "reserved" as const,
    };
    if (!existing) deliveries.push(delivery);
    const lease = Symbol("attention callback owner");
    this.callbackOwners.set(delivery, lease);
    return { status: "reserved", lease };
  }

  /** Recheck an owned reservation after an await without acquiring a second delivery owner. */
  assertCallbackReservation(input: {
    link: AgentAttentionLink;
    peer: AgentAttentionPeer;
    outcomeId: string;
    deliveryId: string;
    lease: symbol;
  }): void {
    const delegation = this.findDelegation(input.link, input.peer);
    const reservation = delegation.deliveries?.find((entry) => entry.outcomeId === input.outcomeId);
    if (
      !reservation ||
      reservation.status !== "reserved" ||
      reservation.deliveryId !== input.deliveryId ||
      this.callbackOwners.get(reservation) !== input.lease
    )
      throw new AttentionObjectiveError("callback reservation changed");
  }

  /** A failed queue/start admission leaves the same immutable outcome available for a retry. */
  releaseCallback(input: {
    link: AgentAttentionLink;
    peer: AgentAttentionPeer;
    deliveryId: string;
    lease: symbol;
  }): void {
    const delegation = this.findDelegation(input.link, input.peer);
    delegation.deliveries = delegation.deliveries?.filter((entry) => {
      if (
        entry.deliveryId !== input.deliveryId ||
        entry.status === "consumed" ||
        this.callbackOwners.get(entry) !== input.lease
      )
        return true;
      this.callbackOwners.delete(entry);
      return false;
    });
  }

  private findDelegation(link: AgentAttentionLink, peer: AgentAttentionPeer) {
    const delegation = this.state.delegations.find(
      (entry) =>
        entry.objectiveId === link.objectiveId &&
        entry.token === link.token &&
        entry.requestId === link.requestId &&
        this.samePeer(entry.recipient, peer),
    );
    if (!delegation || !this.state.objectives.some((entry) => entry.id === link.objectiveId))
      throw new AttentionObjectiveError(link.objectiveId);
    return delegation;
  }

  private activeObjectives(): AttentionObjective[] {
    const ids = new Set(this.state.activeObjectiveIds);
    return this.state.objectives.filter(({ id }) => ids.has(id));
  }

  /** Capture original agent recipients as object-owned members, never a later active-ID snapshot. */
  private captureBlockerMembers(ids?: readonly string[]): AttentionBlockerMember[] {
    if (!this.isAudienceKnown) return [];
    const members: AttentionBlockerMember[] = [];
    for (const objective of this.activeObjectives()) {
      if (objective.audience.kind !== "agent") continue;
      if (ids && !ids.includes(objective.id)) continue;
      members.push({
        objectiveId: objective.id,
        requester: structuredClone(objective.audience.requester),
        isCurrent: () => this.activeObjectives().includes(objective),
      });
    }
    return members;
  }

  private requireActiveObjective(objectiveId: string): AttentionObjective {
    const objective = this.activeObjectives().find(({ id }) => id === objectiveId);
    if (!objective) {
      throw new AttentionObjectiveError(objectiveId);
    }
    return objective;
  }

  private admitInput(input: AttentionAdmission): string[] {
    if (input.kind === "continuation") {
      this.assertContinuation(input);
      const known = new Set(this.state.objectives.map(({ id }) => id));
      return input.objectiveIds.filter((id) => known.has(id));
    }
    if (input.kind === "agent" && input.attention?.continuation) {
      return [this.resolveAgentContinuation(input).id];
    }
    const existing = this.state.objectives.find(({ id }) => id === input.requestId);
    if (existing) {
      return [existing.id];
    }
    const audience =
      input.kind === "human"
        ? { kind: "human" as const }
        : { kind: "agent" as const, requester: structuredClone(input.requester) };
    this.state.objectives.push({
      id: input.requestId,
      audience,
      disposition: "normal",
      replyTo:
        input.kind === "agent"
          ? structuredClone(input.attention?.requesterObjective ?? null)
          : null,
      announcedReasons: [],
    });
    return [input.requestId];
  }

  /** An invalid claim is rejected, never reclassified as a fresh ordinary agent request. */
  private resolveAgentContinuation(
    input: Extract<AttentionAdmission, { kind: "agent" }>,
  ): AttentionObjective {
    const link = input.attention?.continuation;
    if (!link) throw new AttentionObjectiveError("missing continuation claim");
    const delegation = this.findDelegation(link, input.requester);
    if (delegation.acceptedMessageIds?.includes(input.requestId))
      throw new AttentionObjectiveError("replayed continuation");
    const deliveryClaim = input.attention?.delivery;
    if (deliveryClaim) {
      const reservation = delegation.deliveries?.find(
        (entry) => entry.outcomeId === deliveryClaim.outcomeId,
      );
      if (
        !reservation ||
        reservation.status !== "reserved" ||
        reservation.deliveryId !== deliveryClaim.deliveryId ||
        input.requestId !== deliveryClaim.deliveryId ||
        !this.callbackOwners.has(reservation)
      )
        throw new AttentionObjectiveError("unreserved outcome delivery");
    }
    const objective = this.state.objectives.find(({ id }) => id === link.objectiveId);
    if (!objective) throw new AttentionObjectiveError(link.objectiveId);
    return objective;
  }

  private samePeer(left: AgentAttentionPeer, right: AgentAttentionPeer): boolean {
    return (
      left.agentId === right.agentId &&
      (left.serverId ?? this.localServerId) === (right.serverId ?? this.localServerId)
    );
  }
}
