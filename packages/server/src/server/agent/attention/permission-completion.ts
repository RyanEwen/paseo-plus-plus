import type { AgentAttentionObjectives } from "./objectives.js";

type ResponseDisposition = "pending" | "no_follow_up" | "follow_up" | "unknown";

interface PermissionResponse {
  token: symbol;
  disposition: ResponseDisposition;
}

/**
 * Retain one accepted turn's actual terminal until its permission submissions can classify it.
 * This process-local decision never starts work, changes lifecycle, or persists replayable events.
 */
export class AttentionPermissionCompletion {
  private membership: ReturnType<AgentAttentionObjectives["capture"]>;
  private readonly permissions = new Set<string>();
  private readonly responses = new Map<string, PermissionResponse>();
  private finishRequests: (() => void) | undefined;
  private retired = false;
  private completed = false;

  constructor(
    private readonly objectives: AgentAttentionObjectives,
    private readonly turnId: string,
    private readonly ownsManagedInstance: () => boolean,
  ) {
    this.membership = objectives.capture();
  }

  /** Current admission and still-active membership fence every delayed response and terminal. */
  matches(objectives: AgentAttentionObjectives, turnId = this.turnId): boolean {
    if (this.retired || this.completed || !this.ownsManagedInstance()) return false;
    if (objectives !== this.objectives || turnId !== this.turnId) return false;
    const current = objectives.capture();
    return (
      current.admissionId === this.membership.admissionId &&
      this.membership.objectiveIds.length > 0 &&
      this.membership.objectiveIds.every((id) => current.objectiveIds.includes(id))
    );
  }

  /**
   * Prepare before an accepted same-turn steer changes admission ID; commit synchronously after it.
   * Preserve checkpoint/attempt identities, but never attach a captured terminal to later members.
   */
  prepareSteerAdmission(
    objectives: AgentAttentionObjectives,
    turnId: string,
  ): (() => boolean) | undefined {
    if (!this.matches(objectives, turnId) || this.finishRequests) return undefined;
    const previous = this.membership;
    let consumed = false;
    return () => {
      if (consumed) return false;
      consumed = true;
      const sameOwner =
        this.membership === previous &&
        !this.retired &&
        !this.completed &&
        this.ownsManagedInstance();
      if (!sameOwner || this.finishRequests) return false;
      const current = objectives.capture();
      const renewedAdmission = current.admissionId !== previous.admissionId;
      const retainedMembers = previous.objectiveIds.every((id) =>
        current.objectiveIds.includes(id),
      );
      if (!renewedAdmission || !retainedMembers) return false;
      this.membership = current;
      return true;
    };
  }

  /** Only a checkpoint observed in this accepted scope can acquire a response decision. */
  observePermission(permissionId: string): void {
    this.permissions.add(permissionId);
  }

  /** Retry replaces only this permission's failed/unknown attempt, never a competing operation. */
  beginResponse(permissionId: string): symbol | undefined {
    if (!this.matches(this.objectives) || !this.permissions.has(permissionId)) return undefined;
    const token = Symbol("permission response");
    this.responses.set(permissionId, { token, disposition: "pending" });
    return token;
  }

  /** A completed scope may finish its response cleanup, but a retired admission may not. */
  ownsResponse(token: symbol): boolean {
    if (this.retired || !this.ownsManagedInstance()) return false;
    if (this.objectives.capture().admissionId !== this.membership.admissionId) return false;
    return [...this.responses.values()].some((response) => response.token === token);
  }

  /** Classify immediately after the provider await; later refresh failures cannot undo its result. */
  classify(token: symbol, disposition: Exclude<ResponseDisposition, "pending">): void {
    if (!this.matches(this.objectives)) return;
    const response = [...this.responses.values()].find((entry) => entry.token === token);
    if (response?.disposition === "pending") response.disposition = disposition;
  }

  /** Capture once from the real SDK terminal, after canonical content has been flushed. */
  observeTerminal(objectives: AgentAttentionObjectives, turnId: string): boolean {
    if (!this.matches(objectives, turnId)) return false;
    this.finishRequests ??= objectives.requests.captureCompletion(turnId);
    return true;
  }

  /**
   * Complete actual terminal evidence with no blocker and every submission classified no-follow-up.
   * An empty submission set keeps ordinary accepted replies automatic.
   * Undefined means deferred; false means a completed agent/waiting objective, without human alert.
   */
  reconcile(pendingPermissionCount: number): boolean | undefined {
    if (!this.matches(this.objectives) || !this.finishRequests) return undefined;
    if (pendingPermissionCount > 0) return undefined;
    const allSettledWithoutFollowUp = [...this.responses.values()].every(
      (response) => response.disposition === "no_follow_up",
    );
    if (!allSettledWithoutFollowUp) return undefined;

    // Consume before external state/outcome observers can re-enter the manager.
    this.completed = true;
    const finishRequests = this.finishRequests;
    this.finishRequests = undefined;
    finishRequests();
    return this.objectives.finish();
  }

  /** Replacement, actual cancellation/failure, and committed closure retire decisions permanently. */
  retire(): void {
    this.retired = true;
    this.finishRequests = undefined;
    this.permissions.clear();
    this.responses.clear();
  }
}
