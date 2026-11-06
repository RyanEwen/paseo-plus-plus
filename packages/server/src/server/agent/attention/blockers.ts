import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentAttentionPeer } from "@getpaseo/protocol/agent-attention";

const checkpointFields = {
  id: z.string(),
  turnId: z.string().nullable(),
  objectiveIds: z.array(z.string()),
};

const checkpointSchema = z.discriminatedUnion("reason", [
  z.object({
    ...checkpointFields,
    reason: z.literal("permission"),
    permissionId: z.string(),
  }),
  z.object({ ...checkpointFields, reason: z.literal("error") }),
]);

/** Private provenance is dormant after restore until current provider state verifies its blocker. */
export const StoredAttentionBlockersSchema = z.array(checkpointSchema);
type StoredAttentionBlockers = z.infer<typeof StoredAttentionBlockersSchema>;
export type AttentionBlockerCheckpoint = z.infer<typeof checkpointSchema>;

export interface AttentionBlockerMember {
  objectiveId: string;
  requester: AgentAttentionPeer;
  /** Object identity, rather than a reusable request ID, owns the accepted objective. */
  isCurrent: () => boolean;
}

interface Checkpoint {
  state: AttentionBlockerCheckpoint;
  members: AttentionBlockerMember[];
  verified: boolean;
}

export interface AttentionBlockerEscalation {
  objectiveId: string;
  reason: AttentionBlockerCheckpoint["reason"];
  isCurrent: () => boolean;
}

interface VerificationOptions {
  resolveRequester: (peer: AgentAttentionPeer) => Promise<"available" | "missing" | "unknown">;
  isCurrent: (checkpoint: AttentionBlockerCheckpoint) => boolean;
  escalate: (input: AttentionBlockerEscalation) => Promise<void>;
  lostLocalRequesters?: ReadonlySet<string>;
}

/**
 * Own the original recipients of each actual blocker, independently of later same-turn steers.
 * Process-local checkpoint and objective identities fence lookups; persisted IDs only restore
 * known provenance and never replay an alert or establish current provider permission state.
 */
export class AttentionBlockers {
  private readonly checkpoints = new Map<string, Checkpoint>();
  private acceptedTurnId: string | undefined;
  private suspended = false;
  private availabilityEpoch = Symbol("attention requester verification context");

  constructor(
    stored: StoredAttentionBlockers | undefined,
    private readonly captureMembers: (ids?: readonly string[]) => AttentionBlockerMember[],
    private localServerId?: string,
  ) {
    for (const state of stored ?? []) {
      this.checkpoints.set(this.key(state), {
        state: structuredClone(state),
        members: captureMembers(state.objectiveIds),
        verified: false,
      });
    }
  }

  /** Preserve known membership through ordinary close; do not persist live verification or leases. */
  snapshot(): StoredAttentionBlockers {
    const states: StoredAttentionBlockers = [];
    for (const checkpoint of this.checkpoints.values()) {
      const objectiveIds = checkpoint.members
        .filter((member) => member.isCurrent())
        .map((member) => member.objectiveId);
      if (objectiveIds.length > 0)
        states.push({ ...structuredClone(checkpoint.state), objectiveIds });
    }
    return states;
  }

  /** Retain known checkpoint owners, but retire availability evidence from the previous route. */
  bindHost(localServerId: string): void {
    this.localServerId = localServerId;
    this.availabilityEpoch = Symbol("attention requester verification context");
  }

  /** A steer keeps earlier checkpoints; a new accepted SDK turn permanently retires them. */
  admit(input: { turnId?: string; steering: boolean }): void {
    if (!input.steering || input.turnId !== this.acceptedTurnId) this.retire();
    this.acceptedTurnId = input.turnId;
  }

  /** Duplicate delivery of an unresolved permission cannot acquire a later steer's membership. */
  observePermission(input: { turnId: string; permissionId: string }): void {
    if (this.suspended || input.turnId !== this.acceptedTurnId) return;
    const key = `permission:${input.permissionId}`;
    if (this.checkpoints.has(key)) return;
    this.store({
      id: randomUUID(),
      reason: "permission",
      turnId: input.turnId,
      permissionId: input.permissionId,
      objectiveIds: [],
    });
  }

  /** A real failure may belong to a rejected startup, without minting SDK acceptance evidence. */
  observeFailure(): void {
    if (this.suspended) return;
    this.store({
      id: randomUUID(),
      reason: "error",
      turnId: this.acceptedTurnId ?? null,
      objectiveIds: [],
    });
  }

  /** Resolution is final for this checkpoint even if a later request reuses its permission ID. */
  resolvePermission(permissionId: string): void {
    this.checkpoints.delete(`permission:${permissionId}`);
  }

  /**
   * A successful authoritative provider query activates only already-known pending provenance.
   * Historical resolved questions are pruned, and no checkpoint or alert is inferred from history.
   */
  synchronizePermissions(permissionIds: readonly string[]): void {
    if (this.suspended) return;
    const pending = new Set(permissionIds);
    for (const [key, checkpoint] of this.checkpoints) {
      if (checkpoint.state.reason !== "permission") continue;
      if (pending.has(checkpoint.state.permissionId)) checkpoint.verified = true;
      else this.checkpoints.delete(key);
    }
  }

  /** Actual cancel/replacement retires lookups, including when all string IDs are later reused. */
  retire(): void {
    this.checkpoints.clear();
    this.acceptedTurnId = undefined;
  }

  /** Closure/archive invalidates live operations while preserving known metadata for quiet reload. */
  suspend(): void {
    this.suspended = true;
  }

  /** Recheck only original checkpoint members, optionally narrowed to committed local loss IDs. */
  async verify(options: VerificationOptions): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const checkpoint of this.checkpoints.values()) {
      for (const member of checkpoint.members)
        tasks.push(this.verifyMember(checkpoint, member, options));
    }
    await Promise.all(tasks);
  }

  private store(state: AttentionBlockerCheckpoint): void {
    const members = this.captureMembers();
    if (members.length === 0) return;
    state.objectiveIds = members.map((member) => member.objectiveId);
    this.checkpoints.set(this.key(state), { state, members, verified: true });
  }

  private key(state: AttentionBlockerCheckpoint): string {
    if (state.reason === "permission") return `permission:${state.permissionId}`;
    return "error";
  }

  /** Recheck the exact checkpoint and objective again inside the durable escalation operation. */
  private async verifyMember(
    checkpoint: Checkpoint,
    member: AttentionBlockerMember,
    options: VerificationOptions,
  ): Promise<void> {
    if (!this.matchesLocalLoss(member.requester, options.lostLocalRequesters)) return;
    const availabilityEpoch = this.availabilityEpoch;
    const isCurrent = () =>
      !this.suspended &&
      this.availabilityEpoch === availabilityEpoch &&
      checkpoint.verified &&
      this.checkpoints.get(this.key(checkpoint.state)) === checkpoint &&
      member.isCurrent() &&
      options.isCurrent(checkpoint.state);
    if (!isCurrent()) return;
    const availability = await options.resolveRequester(member.requester);
    if (availability !== "missing" || !isCurrent()) return;
    await options.escalate({
      objectiveId: member.objectiveId,
      reason: checkpoint.state.reason,
      isCurrent,
    });
  }

  private matchesLocalLoss(
    requester: AgentAttentionPeer,
    lostLocalRequesters?: ReadonlySet<string>,
  ): boolean {
    if (!lostLocalRequesters) return true;
    const remote = requester.serverId && requester.serverId !== this.localServerId;
    return !remote && lostLocalRequesters.has(requester.agentId);
  }
}
