import type { ManagedAgent } from "../agent-manager.js";
import { registerForkCapability } from "../../fork-capabilities.js";

// The agent manager always loads this policy, so a daemon built with this layer advertises
// audience-aware attention and its host-owned Notifications preference.
registerForkCapability("agentAudienceAttention");
registerForkCapability("agentAudienceAttentionSettings");

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
  private enabled = true;

  get agentAware(): boolean {
    return this.enabled;
  }

  /** Config apply/rollback only. Refresh belongs to committed config observers, never this setter. */
  setAgentAware(enabled: boolean): void {
    this.enabled = enabled;
  }

  /** Intervention reasons stay visible even when legacy routine presentation is selected. */
  static project(input: AttentionProjectionInput): boolean | undefined {
    if (input.requiresAttention && input.attentionMessage) {
      return true;
    }
    return input.enabled ? input.humanAttentionRequired : undefined;
  }

  /** Read presentation separately from the persisted recipient and immutable request ledger. */
  static forAgent(agent: ManagedAgent): boolean | undefined {
    const ledger = agent.attentionObjectives;
    const enabled = ledger?.agentAwarePresentation ?? true;
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
    if (input.intervention) {
      return true;
    }
    if (!this.enabled) {
      return !input.delegated;
    }
    return input.knownAudience || !input.delegated;
  }
}
