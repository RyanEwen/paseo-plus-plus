import type { StoredAgentRecord } from "../agent-storage.js";
import { AgentAttentionObjectives } from "./objectives.js";

/** Clear an acknowledged event without changing its objective or blocker evidence.
 * Stored-only records have no authoritative pending-permission collection; callers
 * exclude permission attention before entering this current-record mutation. */
export function clearStoredAttentionEvent(record: StoredAgentRecord): StoredAgentRecord {
  const next: StoredAgentRecord = {
    ...record,
    updatedAt: new Date().toISOString(),
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    attentionMessage: null,
  };
  if (record.humanAttentionRequired === undefined) return next;
  const hasProblem = record.lastStatus === "error";
  const derived = record.attentionObjectives
    ? new AgentAttentionObjectives(record.attentionObjectives).requiresHumanAttention({
        hasUnread: false,
        hasProblem,
      })
    : undefined;
  // Older known projections without a usable audience retain their problem
  // decision. Completing a read does not resolve a still-authoritative error.
  next.humanAttentionRequired = derived ?? (hasProblem ? record.humanAttentionRequired : false);
  return next;
}
