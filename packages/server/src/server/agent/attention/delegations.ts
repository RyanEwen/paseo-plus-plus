import type { AttentionFailureReason } from "./errors.js";
import type { AgentAttentionLink, AgentAttentionPeer } from "@getpaseo/protocol/agent-attention";
import type { AgentAttentionOutcome } from "@getpaseo/protocol/messages";
import { samePeer } from "./peers.js";

/** One exact outcome a delegation reserved or consumed as a callback. */
export interface CallbackDelivery {
  outcomeId: string;
  deliveryId: string;
  status: "reserved" | "consumed";
}

/** The delegation fields callback reservations read and write. */
interface CallbackDelegation {
  deliveries?: CallbackDelivery[];
}

/** A lease belongs to one live watcher and is deliberately absent from persisted and wire state. */
export type AttentionCallbackReservation =
  | { status: "reserved"; lease: symbol }
  | { status: "consumed" };

/** Raised by the ledger for a claim it refuses; the message names the refusal. */
type RefusalFactory = (reason: AttentionFailureReason) => Error;

/**
 * Live ownership of callback deliveries on delegations. Persisted deliveries record what was
 * reserved or consumed; only this process-local map says which watcher may still dispatch one.
 */
export class CallbackReservations {
  private readonly owners = new WeakMap<CallbackDelivery, symbol>();

  constructor(private readonly refuse: RefusalFactory) {}

  /**
   * Reserve an immutable outcome for one exact callback message before enqueueing it. A restored
   * unconsumed reservation has no live owner and can be reacquired only for its original message.
   */
  reserve(input: {
    delegation: CallbackDelegation;
    link: AgentAttentionLink;
    requester: AgentAttentionPeer;
    outcome: AgentAttentionOutcome;
    deliveryId: string;
    localServerId: string | undefined;
  }): AttentionCallbackReservation {
    const { delegation, outcome } = input;
    if (
      (outcome.kind === "rejected") !== (outcome.acceptedTurnId === null) ||
      (outcome.kind === "permission" && !outcome.permission)
    ) {
      throw this.refuse("invalid-outcome-evidence");
    }
    if (
      outcome.requestId !== input.link.requestId ||
      !samePeer({
        left: input.requester,
        right: outcome.requester,
        localServerId: input.localServerId,
      })
    ) {
      throw this.refuse("outcome-identity-mismatch");
    }
    const deliveries = (delegation.deliveries ??= []);
    const existing = deliveries.find((entry) => entry.outcomeId === outcome.id);
    if (existing) {
      if (existing.deliveryId !== input.deliveryId) {
        throw this.refuse("outcome-message-changed");
      }
      if (existing.status === "consumed") {
        return { status: "consumed" };
      }
      if (this.owners.has(existing)) {
        throw this.refuse("outcome-already-reserved");
      }
    }
    const delivery = existing ?? {
      outcomeId: outcome.id,
      deliveryId: input.deliveryId,
      status: "reserved" as const,
    };
    if (!existing) {
      deliveries.push(delivery);
    }
    const lease = Symbol("attention callback owner");
    this.owners.set(delivery, lease);
    return { status: "reserved", lease };
  }

  /** Recheck an owned reservation after an await without acquiring a second delivery owner. */
  assert(input: {
    delegation: CallbackDelegation;
    outcomeId: string;
    deliveryId: string;
    lease: symbol;
  }): void {
    const reservation = input.delegation.deliveries?.find(
      (entry) => entry.outcomeId === input.outcomeId,
    );
    if (
      !reservation ||
      reservation.status !== "reserved" ||
      reservation.deliveryId !== input.deliveryId ||
      this.owners.get(reservation) !== input.lease
    ) {
      throw this.refuse("callback-reservation-changed");
    }
  }

  /** A failed queue/start admission leaves the same immutable outcome available for a retry. */
  release(input: { delegation: CallbackDelegation; deliveryId: string; lease: symbol }): void {
    const deliveries = input.delegation.deliveries;
    const index =
      deliveries?.findIndex(
        (entry) =>
          entry.deliveryId === input.deliveryId &&
          entry.status !== "consumed" &&
          this.owners.get(entry) === input.lease,
      ) ?? -1;
    if (!deliveries || index === -1) {
      return;
    }
    const [released] = deliveries.splice(index, 1);
    if (released) {
      this.owners.delete(released);
    }
  }

  /** Whether a live watcher currently owns this delivery. */
  isOwned(delivery: CallbackDelivery): boolean {
    return this.owners.has(delivery);
  }

  /** Mark a delivered callback consumed and retire its owner. */
  consume(delivery: CallbackDelivery): void {
    delivery.status = "consumed";
    this.owners.delete(delivery);
  }
}
