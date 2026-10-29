import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import type { AgentHistoryResult } from "./agent-history-fetch";
import type { WorkspaceTab } from "@/workspace-tabs/model";

/** Keep unopened conversations once each; runtime status does not indicate tab visibility. */
export function selectPreviousAgents(
  agents: readonly AggregatedAgent[],
  tabs: readonly WorkspaceTab[],
): AggregatedAgent[] {
  const openIds = new Set(
    tabs.flatMap((tab) => (tab.target.kind === "agent" ? [tab.target.agentId] : [])),
  );
  const seen = new Set<string>();
  return agents.filter((agent) => {
    const key = `${agent.serverId}:${agent.id}`;
    if (openIds.has(agent.id) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Derive progress after excluding open tabs from the history rows.
 * Disconnected hosts can retain successful cursors or an in-flight initial request,
 * so host failure takes precedence over either source of progress.
 */
export function resolveClosedAgentDialogState(input: {
  closedAgentCount: number;
  history: Pick<AgentHistoryResult, "hasMore" | "isError" | "hostErrors" | "isInitialLoad">;
}) {
  const failed = input.history.isError || input.history.hostErrors.length > 0;
  const scanningOpenPages = input.closedAgentCount === 0 && input.history.hasMore && !failed;
  const showLoading =
    !failed && input.closedAgentCount === 0 && (input.history.isInitialLoad || scanningOpenPages);
  return { failed, scanningOpenPages, showLoading };
}

export interface PreviousAgentsAvailability {
  serverId: string;
  workspaceId: string;
  readReady: boolean;
  enabled: boolean;
}

/** A normalized default is usable only after the selected settings authority has been read. */
export function isPreviousAgentsAvailable(input: PreviousAgentsAvailability): boolean {
  return (
    input.readReady &&
    input.enabled &&
    input.serverId.trim().length > 0 &&
    input.workspaceId.trim().length > 0
  );
}

/** Retained menu callbacks recheck current authority and capture the exact destination on invocation. */
export function createPreviousAgentLaunchAction(input: {
  identity: { serverId: string; workspaceId: string };
  readAvailability: () => PreviousAgentsAvailability;
  open: (identity: { serverId: string; workspaceId: string }) => void;
}): () => void {
  return () => {
    const current = input.readAvailability();
    if (!isPreviousAgentsAvailable(current)) return;
    if (
      current.serverId !== input.identity.serverId ||
      current.workspaceId !== input.identity.workspaceId
    )
      return;
    input.open({ ...input.identity });
  };
}
