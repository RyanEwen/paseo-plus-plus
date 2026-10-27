import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AgentAttentionOutcomeSchema,
  type AgentAttentionOutcome,
} from "@getpaseo/protocol/messages";
import {
  AgentAttentionLinkSchema,
  AgentAttentionPeerSchema,
  type AgentAttentionPeer,
  type AgentAttentionRequestQuery,
} from "@getpaseo/protocol/agent-attention";
import type { AttentionAdmission } from "./objectives.js";

const requestSchema = z.object({
  link: AgentAttentionLinkSchema,
  requester: AgentAttentionPeerSchema,
  objectiveId: z.string(),
  turnId: z.string().nullable(),
  active: z.boolean(),
  lastMessage: z.string().nullable(),
  outcomes: z.array(AgentAttentionOutcomeSchema),
});
export const StoredAttentionRequestsSchema = z.object({
  records: z.array(requestSchema),
  checkpoints: z.array(z.object({ turnId: z.string(), permissionId: z.string() })),
});
type Request = z.infer<typeof requestSchema>;
export type StoredAttentionRequests = z.infer<typeof StoredAttentionRequestsSchema>;

/** Target-owned acceptance and immutable outcomes, retained until the requester acknowledges them. */
export class AgentAttentionRequests {
  private records: Request[];
  private checkpoints: Array<{ turnId: string; permissionId: string }>;
  constructor(
    stored?: StoredAttentionRequests,
    private serverId?: string,
  ) {
    this.records = structuredClone(stored?.records ?? []);
    this.checkpoints = structuredClone(stored?.checkpoints ?? []);
  }

  /** Update only implicit-local comparison context; captured terminal closures keep their records. */
  bindHost(serverId: string): void {
    this.serverId = serverId;
  }

  snapshot(): StoredAttentionRequests {
    return structuredClone({ records: this.records, checkpoints: this.checkpoints });
  }

  /** Only provider acceptance creates an accepted record. Permission continuations retain membership. */
  accept(input: {
    admissions: readonly AttentionAdmission[];
    turnId: string;
    steering: boolean;
    objectives: ReadonlyMap<string, string>;
  }): void {
    this.checkpoints = this.checkpoints.filter((entry) => entry.turnId === input.turnId);
    const continuedIds = new Set(
      input.admissions.flatMap((entry) =>
        entry.kind === "continuation" ? [...entry.objectiveIds] : [],
      ),
    );
    if (!input.steering) {
      for (const record of this.records) {
        if (!record.active) continue;
        if (continuedIds.has(record.objectiveId)) {
          record.turnId = input.turnId;
        } else {
          this.append(record, "canceled", "Replaced by another accepted request");
        }
      }
    }
    for (const admission of input.admissions) {
      if (admission.kind !== "agent" || !admission.attention?.requesterObjective) continue;
      const link = admission.attention.requesterObjective;
      if (this.records.some((record) => record.link.requestId === link.requestId)) continue;
      const objectiveId = input.objectives.get(admission.requestId);
      if (!objectiveId) throw new Error("Accepted request has no objective membership");
      this.records.push({
        link: structuredClone(link),
        requester: structuredClone(admission.requester),
        objectiveId,
        turnId: input.turnId,
        active: true,
        lastMessage: null,
        outcomes: [],
      });
    }
  }

  /** Submission rejection reports its own error without certifying SDK acceptance or copying old output. */
  reject(admissions: readonly AttentionAdmission[], error: string): void {
    for (const admission of admissions) {
      if (admission.kind !== "agent" || !admission.attention?.requesterObjective) continue;
      const link = admission.attention.requesterObjective;
      if (this.records.some((record) => record.link.requestId === link.requestId)) continue;
      const record: Request = {
        link: structuredClone(link),
        requester: structuredClone(admission.requester),
        objectiveId: admission.requestId,
        turnId: null,
        active: false,
        lastMessage: null,
        outcomes: [],
      };
      this.records.push(record);
      this.append(record, "rejected", error);
    }
  }

  /** Keep current-turn content so forced replacement cannot substitute a later turn's response. */
  updateContent(turnId: string, text: string): void {
    for (const record of this.records)
      if (record.active && record.turnId === turnId) record.lastMessage = text;
  }

  /** Freeze terminal membership/content now; a delayed permission decision cannot borrow new output. */
  captureCompletion(turnId: string): () => void {
    const members = this.records
      .filter((record) => record.active && record.turnId === turnId)
      .map((record) => ({ record, lastMessage: record.lastMessage }));
    let completed = false;
    return () => {
      if (completed) return;
      completed = true;
      for (const { record, lastMessage } of members) {
        if (!this.records.includes(record) || !record.active || record.turnId !== turnId) continue;
        this.append(record, "finished", null, undefined, lastMessage);
      }
    };
  }

  /** Checkpoints belong only to requests accepted before this event in this SDK turn. */
  record(input: {
    turnId: string;
    kind: Exclude<AgentAttentionOutcome["kind"], "rejected">;
    lastMessage?: string | null;
    error?: string;
    permission?: AgentAttentionOutcome["permission"];
  }): void {
    if (input.kind === "permission" && input.permission) {
      if (
        this.checkpoints.some(
          (entry) => entry.turnId === input.turnId && entry.permissionId === input.permission?.id,
        )
      )
        return;
      this.checkpoints.push({ turnId: input.turnId, permissionId: input.permission.id });
    }
    for (const record of this.records) {
      if (!record.active || record.turnId !== input.turnId) continue;
      if (input.lastMessage !== undefined) record.lastMessage = input.lastMessage;
      this.append(record, input.kind, input.error ?? null, input.permission);
    }
  }

  /** Acknowledgement retires only the exact delivered outcome, never another request's evidence. */
  read(query: AgentAttentionRequestQuery): {
    outcome: AgentAttentionOutcome | null;
    pending: boolean;
    known: boolean;
  } {
    const record = this.records.find((entry) => entry.link.requestId === query.link.requestId);
    if (!record) return { outcome: null, pending: false, known: false };
    if (
      record.link.token !== query.link.token ||
      record.link.objectiveId !== query.link.objectiveId ||
      !this.samePeer(record.requester, query.requester)
    ) {
      throw new Error("Attention outcome does not belong to this requester");
    }
    if (query.acknowledgeOutcomeId) {
      record.outcomes = record.outcomes.filter(
        (outcome) => outcome.id !== query.acknowledgeOutcomeId,
      );
      if (!record.active && record.outcomes.length === 0)
        this.records = this.records.filter((entry) => entry !== record);
    }
    return {
      outcome: structuredClone(record.outcomes[0] ?? null),
      pending: record.active,
      known: true,
    };
  }

  private append(
    record: Request,
    kind: AgentAttentionOutcome["kind"],
    error: string | null = null,
    permission?: AgentAttentionOutcome["permission"],
    lastMessage: string | null = record.lastMessage,
  ): void {
    record.outcomes.push({
      id: randomUUID(),
      requestId: record.link.requestId,
      requester: record.requester,
      acceptedTurnId: record.turnId,
      kind,
      lastMessage,
      error,
      ...(permission ? { permission: structuredClone(permission) } : {}),
    });
    if (kind !== "permission") record.active = false;
  }

  private samePeer(left: AgentAttentionPeer, right: AgentAttentionPeer): boolean {
    return (
      left.agentId === right.agentId &&
      (left.serverId ?? this.serverId) === (right.serverId ?? this.serverId)
    );
  }
}
