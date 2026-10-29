import type { Agent } from "@/stores/session-store";
import type {
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import { aggregateKnownSidebarStateBuckets } from "@/utils/sidebar-agent-state";

/** Only authoritative lifetime relationships participate in workspace ownership. */
export type WorkspaceTreeAgent = Pick<Agent, "id" | "workspaceId" | "parentAgentId" | "archivedAt">;

export interface WorkspaceTreeSession {
  serverId: string;
  hasHydratedAgents: boolean;
  agents: ReadonlyMap<string, WorkspaceTreeAgent>;
}

/**
 * Find a workspace's unique owner using every live local agent, including internal descendants.
 * Missing ancestors, independent agents and disagreement leave the workspace at the top level.
 * Session and project boundaries are never inferred from paths or display names.
 */
export function resolveWorkspaceParents(input: {
  workspaces: readonly SidebarWorkspacePlacement[];
  sessions: readonly WorkspaceTreeSession[];
}): ReadonlyMap<string, string> {
  const parents = new Map<string, string>();
  for (const session of input.sessions) {
    if (!session.hasHydratedAgents) continue;
    const workspaces = new Map(
      input.workspaces
        .filter((workspace) => workspace.serverId === session.serverId)
        .map((workspace) => [workspace.workspaceId, workspace]),
    );
    const agentsByWorkspace = new Map<string, WorkspaceTreeAgent[]>();
    for (const agent of session.agents.values()) {
      if (agent.archivedAt || !agent.workspaceId) continue;
      const agents = agentsByWorkspace.get(agent.workspaceId) ?? [];
      agents.push(agent);
      agentsByWorkspace.set(agent.workspaceId, agents);
    }
    for (const workspace of workspaces.values()) {
      const agents = agentsByWorkspace.get(workspace.workspaceId);
      if (!agents?.length) continue;
      const candidates = agents.map((agent) => nearestExternalWorkspace(agent, session.agents));
      const parentId = candidates[0];
      if (!parentId || !candidates.every((candidate) => candidate === parentId)) continue;
      const parent = workspaces.get(parentId);
      if (!parent || parent.projectViewKey !== workspace.projectViewKey) continue;
      parents.set(workspace.workspaceKey, parent.workspaceKey);
    }
  }
  return removeWorkspaceCycles(parents);
}

/** Find the nearest external workspace and validate its full ancestor chain for missing records or cycles. */
function nearestExternalWorkspace(
  agent: WorkspaceTreeAgent,
  agents: ReadonlyMap<string, WorkspaceTreeAgent>,
): string | null {
  const visited = new Set([agent.id]);
  let ancestor = agent;
  let externalWorkspace: string | null = null;
  while (ancestor.parentAgentId) {
    const parent = agents.get(ancestor.parentAgentId);
    if (!parent || parent.archivedAt || visited.has(parent.id) || !parent.workspaceId) {
      return null;
    }
    if (parent.workspaceId !== agent.workspaceId && externalWorkspace === null) {
      externalWorkspace = parent.workspaceId;
    }
    visited.add(parent.id);
    ancestor = parent;
  }
  return externalWorkspace;
}

/** Reject all edges whose ancestry reaches a workspace cycle, including its incoming branches. */
function removeWorkspaceCycles(parents: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
  const safe = new Map<string, string>();
  for (const [child, parent] of parents) {
    const visited = new Set([child]);
    let ancestor: string | undefined = parent;
    while (ancestor !== undefined && !visited.has(ancestor)) {
      visited.add(ancestor);
      ancestor = parents.get(ancestor);
    }
    if (ancestor === undefined) safe.set(child, parent);
  }
  return safe;
}

export interface WorkspaceTreeNode {
  parentKey: string | null;
  childKeys: string[];
  descendantKeys: string[];
}

export const EMPTY_WORKSPACE_TREE: ReadonlyMap<string, WorkspaceTreeNode> = new Map();

/** The existing collapse preference stores namespaced workspace identities beside section keys. */
export function workspaceCollapseKey(workspaceKey: string): string {
  return `workspace:${workspaceKey}`;
}

/** Keep explicit pin sections and filtered project boundaries intact while ordering each family. */
export function orderWorkspaceFamilies<T extends SidebarWorkspacePlacement>(input: {
  workspaces: readonly T[];
  parents: ReadonlyMap<string, string>;
}): { rows: T[]; tree: ReadonlyMap<string, WorkspaceTreeNode> } {
  const items = new Map(input.workspaces.map((workspace) => [workspace.workspaceKey, workspace]));
  const tree = new Map<string, WorkspaceTreeNode>();
  for (const key of items.keys()) {
    const parent = input.parents.get(key);
    const parentKey = parent !== undefined && items.has(parent) ? parent : null;
    tree.set(key, { parentKey, childKeys: [], descendantKeys: [] });
  }
  for (const [key, node] of tree) {
    if (node.parentKey !== null) tree.get(node.parentKey)!.childKeys.push(key);
  }
  const rows: T[] = [];
  function visit(key: string): string[] {
    const node = tree.get(key)!;
    rows.push(items.get(key)!);
    for (const child of node.childKeys) node.descendantKeys.push(...visit(child));
    return [key, ...node.descendantKeys];
  }
  for (const [key, node] of tree) {
    if (node.parentKey === null) visit(key);
  }
  return { rows, tree };
}

/** Roots are the units of count limits and drag movement; their original row identities survive. */
export function workspaceFamilyRoots<T extends SidebarWorkspacePlacement>(
  workspaces: readonly T[],
  tree: ReadonlyMap<string, WorkspaceTreeNode>,
): T[] {
  return workspaces.filter((workspace) => !tree.get(workspace.workspaceKey)?.parentKey);
}

/** Add the selected family to a limited window without changing any saved display preference. */
export function includeActiveWorkspaceFamily<T extends SidebarWorkspacePlacement>(input: {
  roots: readonly T[];
  visibleItems: readonly T[];
  tree: ReadonlyMap<string, WorkspaceTreeNode>;
  activeWorkspaceKey: string | null;
}): T[] {
  const visibleKeys = new Set(input.visibleItems.map((workspace) => workspace.workspaceKey));
  return input.roots.filter((workspace) => {
    if (visibleKeys.has(workspace.workspaceKey)) return true;
    if (input.activeWorkspaceKey === null) return false;
    if (workspace.workspaceKey === input.activeWorkspaceKey) return true;
    const node = input.tree.get(workspace.workspaceKey);
    return node !== undefined && node.descendantKeys.includes(input.activeWorkspaceKey);
  });
}

/** An eligible recent descendant keeps its entire family reachable through the normal window. */
export function workspaceFamilyUpdatedAt(input: {
  workspaceKey: string;
  tree: ReadonlyMap<string, WorkspaceTreeNode>;
  getStatusEnteredAt: (key: string) => Date | null;
}): Date | null {
  const descendants = input.tree.get(input.workspaceKey)?.descendantKeys ?? [];
  let latest: Date | null = null;
  for (const key of [input.workspaceKey, ...descendants]) {
    const date = input.getStatusEnteredAt(key);
    if (date && Number.isFinite(date.getTime()) && (!latest || date > latest)) latest = date;
  }
  return latest;
}

/** Reveal only the active child's ancestry. The saved collapsed preferences remain untouched. */
export function effectiveWorkspaceCollapse(input: {
  tree: ReadonlyMap<string, WorkspaceTreeNode>;
  collapsedKeys: ReadonlySet<string>;
  activeWorkspaceKey: string | null;
}): ReadonlySet<string> {
  const collapsed = new Set(input.collapsedKeys);
  let parent = input.activeWorkspaceKey
    ? input.tree.get(input.activeWorkspaceKey)?.parentKey
    : null;
  while (parent) {
    collapsed.delete(workspaceCollapseKey(parent));
    parent = input.tree.get(parent)?.parentKey;
  }
  return collapsed;
}

/** Remove collapsed descendants from keyboard traversal without changing full group membership. */
export function expandedWorkspaceRows<T extends SidebarWorkspacePlacement>(input: {
  workspaces: readonly T[];
  tree: ReadonlyMap<string, WorkspaceTreeNode>;
  collapsedKeys: ReadonlySet<string>;
}): T[] {
  const hidden = new Set<string>();
  return input.workspaces.filter((workspace) => {
    const key = workspace.workspaceKey;
    if (hidden.has(key)) return false;
    if (input.collapsedKeys.has(workspaceCollapseKey(key))) {
      for (const child of input.tree.get(key)?.descendantKeys ?? []) hidden.add(child);
    }
    return true;
  });
}

/** Status and human attention are independent facts about descendants, never the parent state. */
export function summarizeWorkspaceChildren(input: {
  node: WorkspaceTreeNode;
  entries: ReadonlyMap<string, SidebarWorkspaceEntry>;
  humanAttentionWorkspaceKeys: ReadonlySet<string>;
}) {
  const buckets = input.node.descendantKeys.map(
    (key) => input.entries.get(key)?.statusBucket ?? null,
  );
  const attentionKeys = input.humanAttentionWorkspaceKeys;
  const humanAttentionCount = input.node.descendantKeys.filter((key) =>
    attentionKeys.has(key),
  ).length;
  return {
    count: input.node.descendantKeys.length,
    bucket: aggregateKnownSidebarStateBuckets(buckets),
    humanAttentionCount,
  };
}
