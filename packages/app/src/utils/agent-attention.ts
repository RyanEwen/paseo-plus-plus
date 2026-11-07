import { getAgentStatusPriority } from "@getpaseo/protocol/agent-state-bucket";
import type { Agent } from "@/stores/session-store";

interface ShouldClearAgentAttentionInput {
  agentId: string | null | undefined;
  isConnected: boolean;
  requiresAttention: boolean | null | undefined;
  attentionReason?: "finished" | "error" | "permission" | null | undefined;
  trigger?: AgentAttentionClearTrigger;
  hasDeferredFocusEntryClear?: boolean;
}

export type AgentAttentionClearTrigger =
  | "focus-entry"
  | "input-focus"
  | "prompt-send"
  | "agent-blur";

/**
 * Blockers and failures rank as the shared status priority does; a finished result ranks after
 * them, and an agent with no attention reason is not a candidate.
 */
function getAttentionPriority(agent: Agent): number | null {
  const statusPriority = getAgentStatusPriority({
    status: agent.status,
    pendingPermissionCount: agent.pendingPermissions.length,
    attentionReason: agent.attentionReason,
  });
  if (statusPriority <= 1) {
    return statusPriority;
  }
  return agent.attentionReason === "finished" ? 2 : null;
}

export function pickAttentionAgent(agents: Agent[]): string | null {
  let selectedAgentId: string | null = null;
  let selectedPriority = Number.POSITIVE_INFINITY;
  let selectedTimestamp = Number.POSITIVE_INFINITY;

  for (const agent of agents) {
    if (agent.requiresAttention !== true) {
      continue;
    }

    // A known audience decides: routine agent-directed results do not ask for the human.
    if (agent.humanAttentionRequired === false) {
      continue;
    }
    // COMPAT(agentAudienceAttention): added in v0.15.3, remove after 2027-04-22 once host floor
    // includes audience metadata. Older hosts keep child agents out of the human selection.
    if (agent.parentAgentId && agent.humanAttentionRequired === undefined) {
      continue;
    }

    const priority = getAttentionPriority(agent);
    if (priority === null) {
      continue;
    }

    const timestamp = agent.attentionTimestamp?.getTime() ?? Number.POSITIVE_INFINITY;
    const isHigherPriority = priority < selectedPriority;
    const isOlderAtSamePriority = priority === selectedPriority && timestamp < selectedTimestamp;
    if (isHigherPriority || isOlderAtSamePriority) {
      selectedAgentId = agent.id;
      selectedPriority = priority;
      selectedTimestamp = timestamp;
    }
  }

  return selectedAgentId;
}

export function shouldClearAgentAttention(input: ShouldClearAgentAttentionInput): boolean {
  const agentId = input.agentId?.trim();
  if (!agentId) {
    return false;
  }
  if (!input.isConnected) {
    return false;
  }
  if (!input.requiresAttention) {
    return false;
  }
  if (input.attentionReason === "permission") {
    return false;
  }
  if (input.trigger === "focus-entry" && input.hasDeferredFocusEntryClear === true) {
    return false;
  }
  return true;
}
