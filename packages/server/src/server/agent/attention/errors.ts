/** Why the attention ledger refused an operation. Callers branch on this, not on the message. */
export type AttentionFailureReason =
  | "objective-not-in-turn"
  | "ambiguous-objective"
  | "retired-turn"
  | "retired-continuation"
  | "unknown-continuation"
  | "missing-continuation"
  | "replayed-continuation"
  | "request-identity-mismatch"
  | "request-without-objective"
  | "audience-conflict"
  | "retired-human-claim"
  | "unreserved-delivery"
  | "invalid-outcome-evidence"
  | "outcome-identity-mismatch"
  | "outcome-message-changed"
  | "outcome-already-reserved"
  | "outcome-requester-mismatch"
  | "callback-reservation-changed";

const FAILURE_MESSAGES: Record<AttentionFailureReason, string> = {
  "objective-not-in-turn": "This objective does not belong to this accepted turn",
  "ambiguous-objective": "Specify objectiveId when this turn contains multiple requests",
  "retired-turn": "This request came from a turn that has already ended",
  "retired-continuation": "This permission continuation was replaced by later work",
  "unknown-continuation": "This agent has no request to continue",
  "missing-continuation": "This message does not name the request it continues",
  "replayed-continuation": "This continuation was already accepted",
  "request-identity-mismatch": "This message does not match its delegated request",
  "request-without-objective": "This accepted request has no objective",
  "audience-conflict": "This request ID already belongs to another audience",
  "retired-human-claim": "This human attention request is no longer current",
  "unreserved-delivery": "This outcome delivery was not reserved",
  "invalid-outcome-evidence": "This request outcome has invalid evidence",
  "outcome-identity-mismatch": "This outcome does not match its delegated request",
  "outcome-message-changed": "This outcome is reserved for a different message",
  "outcome-already-reserved": "This outcome is already being delivered",
  "outcome-requester-mismatch": "This outcome does not belong to this requester",
  "callback-reservation-changed": "This callback reservation is no longer held",
};

/** A refused attention operation. The message reaches agents as a tool error. */
export class AttentionObjectiveError extends Error {
  constructor(
    readonly reason: AttentionFailureReason,
    readonly objectiveId?: string,
  ) {
    super(FAILURE_MESSAGES[reason]);
    this.name = "AttentionObjectiveError";
  }
}
