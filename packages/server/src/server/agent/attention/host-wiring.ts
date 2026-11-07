import { isAgentAwareAttentionEnabled } from "@getpaseo/protocol/agent-attention";
import type { AgentAttentionPeer } from "@getpaseo/protocol/agent-attention";
import type { Logger } from "pino";
import type { AgentManager } from "../agent-manager.js";
import type { DaemonConfigStore } from "../../daemon-config-store.js";
import type { ToolHosts } from "../host-operations/index.js";

/**
 * Ask a requester's own host whether it still has that agent.
 *
 * Only an answer from that host proves loss. A transport, routing or authority failure cannot,
 * so it reads as "unknown" and the requester keeps its blockers.
 */
export async function resolveRemoteAttentionRequester(
  peer: AgentAttentionPeer,
  toolHosts: () => ToolHosts,
): Promise<"available" | "missing" | "unknown"> {
  const serverId = peer.serverId;
  if (!serverId) {
    return "unknown";
  }
  try {
    return await toolHosts().use(serverId, async (client) => {
      const result = await client.fetchAgent(peer.agentId);
      return !result || result.agent.archivedAt ? "missing" : "available";
    });
  } catch {
    return "unknown";
  }
}

/**
 * Keep the agent manager's presentation mode on the host-owned Agent-aware attention preference.
 *
 * The mode follows applied config and rolls back with it. Once a changed mode is committed,
 * every connected session reprojects its indicators; provider events and notifications are
 * never replayed. Returns the unsubscribe for both listeners.
 */
export function attachAttentionPresentationConfig(input: {
  store: Pick<DaemonConfigStore, "get" | "onApply" | "onChange">;
  agentManager: Pick<
    AgentManager,
    "setAttentionPresentationEnabled" | "agentAwareAttentionEnabled"
  >;
  sessions: () => Iterable<{ refreshAttentionPresentation(): Promise<void> }>;
  logger: Pick<Logger, "warn">;
}): () => void {
  const { store, agentManager } = input;
  agentManager.setAttentionPresentationEnabled(isAgentAwareAttentionEnabled(store.get()));
  const unsubscribeApply = store.onApply((config, previous) => {
    agentManager.setAttentionPresentationEnabled(isAgentAwareAttentionEnabled(config));
    return () =>
      agentManager.setAttentionPresentationEnabled(isAgentAwareAttentionEnabled(previous));
  });
  let publishedMode = agentManager.agentAwareAttentionEnabled;
  const unsubscribeChange = store.onChange(() => {
    const nextMode = agentManager.agentAwareAttentionEnabled;
    if (nextMode === publishedMode) {
      return;
    }
    publishedMode = nextMode;
    for (const session of new Set(input.sessions())) {
      void session.refreshAttentionPresentation().catch((error) => {
        input.logger.warn({ err: error }, "Failed to refresh attention presentation");
      });
    }
  });
  return () => {
    unsubscribeApply();
    unsubscribeChange();
  };
}
