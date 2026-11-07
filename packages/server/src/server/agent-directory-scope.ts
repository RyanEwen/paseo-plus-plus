import { registerForkCapability } from "./fork-capabilities.js";

// Hosts that load this module answer workspace-scoped history requests.
// COMPAT(workspaceAgentHistory): added in v0.11.2, remove gate after 2027-10-11.
registerForkCapability("workspaceAgentHistory");

/**
 * Keep only the agents that belong to one workspace.
 *
 * Workspace identity is the ownership key: two workspaces can share a cwd, so a cwd match
 * would leak another workspace's history. Callers apply this before cursor pagination so
 * every page is drawn from the scoped set.
 *
 * @param agents Directory rows to filter.
 * @param workspaceId The requested workspace, or undefined for an unscoped (global) read.
 * @returns The input unchanged when unscoped, otherwise only rows owned by the workspace.
 */
export function scopeAgentsToWorkspace<T extends { workspaceId?: string | null }>(
  agents: T[],
  workspaceId: string | undefined,
): T[] {
  if (!workspaceId) return agents;
  return agents.filter((agent) => agent.workspaceId === workspaceId);
}
