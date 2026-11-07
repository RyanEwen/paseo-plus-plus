import {
  hasHumanAgentAttention,
  type HumanAttentionInput,
} from "@getpaseo/protocol/agent-attention";

export type FaviconStatus = "none" | "running" | "attention";

/**
 * One favicon precedence for every host: a running agent shows the loader, otherwise any
 * agent that needs a human shows attention. `hasHumanAgentAttention` owns the audience
 * decision, including the older-host fallback for hosts without audience metadata.
 */
export function deriveFaviconStatus(agents: readonly HumanAttentionInput[]): FaviconStatus {
  if (agents.some((agent) => agent.status === "running")) {
    return "running";
  }
  if (agents.some((agent) => hasHumanAgentAttention(agent))) {
    return "attention";
  }
  return "none";
}
