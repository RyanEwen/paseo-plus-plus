/** The objective fields a human escalation claim reads and announces. */
interface ClaimableObjective {
  announcedReasons: string[];
}

/**
 * Process-local human escalation claims for one objective ledger.
 *
 * A reason is reserved before its write and announced only after the write commits, so ordinary
 * close or reload snapshots never carry a pending reason and a failed write can simply release it.
 */
export class HumanAttentionClaims<Objective extends ClaimableObjective> {
  private readonly owners = new Map<symbol, { objective: Objective; reason: string }>();

  /** Reserve `reason` for `objective`, or null when it is already announced or pending. */
  reserve(objective: Objective, reason: string): symbol | null {
    const pending = [...this.owners.values()].some(
      (owner) => owner.objective === objective && owner.reason === reason,
    );
    if (objective.announcedReasons.includes(reason) || pending) {
      return null;
    }
    const lease = Symbol("human attention owner");
    this.owners.set(lease, { objective, reason });
    return lease;
  }

  owner(lease: symbol): { objective: Objective; reason: string } | undefined {
    return this.owners.get(lease);
  }

  /** Announce the claimed reason on its exact objective and retire the claim. */
  commit(lease: symbol): void {
    const owner = this.owners.get(lease);
    if (!owner) {
      return;
    }
    owner.objective.announcedReasons.push(owner.reason);
    this.owners.delete(lease);
  }

  release(lease: symbol): void {
    this.owners.delete(lease);
  }
}
