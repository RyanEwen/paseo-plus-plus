import type { ManagedAgent } from "../agent-manager.js";
import type { AgentAttentionObjectives } from "./objectives.js";

interface AttentionProjectionInput {
  enabled: boolean;
  humanAttentionRequired: boolean | undefined;
  requiresAttention: boolean;
  attentionMessage?: string | null;
}
interface RoutineNotificationInput {
  knownAudience: boolean;
  delegated: boolean;
  intervention: boolean;
}

/** One daemon's presentation choice. Recipient/acceptance evidence is never changed by this policy. */
export class AttentionPresentation {
  private static readonly owners = new WeakMap<AgentAttentionObjectives, AttentionPresentation>();
  private enabled = true;

  get agentAware(): boolean {
    return this.enabled;
  }

  /** Config apply/rollback only. Refresh belongs to committed config observers, never this setter. */
  setAgentAware(enabled: boolean): void {
    this.enabled = enabled;
  }

  /** Live shallow snapshots retain the ledger identity, so projections share their daemon's policy. */
  attach(objectives: AgentAttentionObjectives): AgentAttentionObjectives {
    AttentionPresentation.owners.set(objectives, this);
    return objectives;
  }

  /** Intervention reasons stay visible even when legacy routine presentation is selected. */
  static project(input: AttentionProjectionInput): boolean | undefined {
    if (input.requiresAttention && input.attentionMessage) return true;
    return input.enabled ? input.humanAttentionRequired : undefined;
  }

  /** Read presentation separately from the persisted recipient and immutable request ledger. */
  static forAgent(agent: ManagedAgent): boolean | undefined {
    const ledger = agent.attentionObjectives;
    const enabled = ledger ? (AttentionPresentation.owners.get(ledger)?.agentAware ?? true) : true;
    return AttentionPresentation.project({
      enabled,
      humanAttentionRequired: ledger?.requiresHumanAttention({
        hasUnread: agent.attention.requiresAttention,
        hasProblem: agent.lifecycle === "error" || agent.pendingPermissions.size > 0,
      }),
      requiresAttention: agent.attention.requiresAttention,
      attentionMessage: agent.attentionMessage,
    });
  }

  /** Legacy parent suppression applies to routine output; explicit/verified intervention bypasses it. */
  allowsNotification(input: RoutineNotificationInput): boolean {
    if (input.intervention) return true;
    if (!this.enabled) return !input.delegated;
    return input.knownAudience || !input.delegated;
  }
}
