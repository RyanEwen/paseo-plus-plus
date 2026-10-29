import type {
  DaemonClient,
  FetchAgentHistoryOptions,
  FetchWorkspacesOptions,
} from "@getpaseo/client/internal/daemon-client";
import type { AgentSnapshotPayload, WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import { i18n } from "@/i18n/i18next";
import type { ProjectArchiveWorkspace } from "./project-workspace-archive";
import type { WorkspaceStructureProject } from "@/projects/workspace-structure";

export interface ProjectArchiveHost {
  serverId: string;
  projectId: string;
}

type DirectoryPageInfo = Awaited<ReturnType<DaemonClient["fetchWorkspaces"]>>["pageInfo"];

interface ProjectArchiveWorkspacePage {
  entries: WorkspaceDescriptorPayload[];
  pageInfo: DirectoryPageInfo;
}

interface ProjectArchiveAgentEntry {
  agent: Pick<AgentSnapshotPayload, "id" | "workspaceId" | "archivedAt" | "status">;
}

interface ProjectArchiveAgentPage {
  entries: ProjectArchiveAgentEntry[];
  pageInfo: DirectoryPageInfo;
}

/** Only the one-shot directory surface is needed; observation does not belong to this operation. */
export interface ProjectArchiveDiscoveryClient {
  fetchWorkspaces: (
    options: Pick<FetchWorkspacesOptions, "filter" | "page">,
  ) => Promise<ProjectArchiveWorkspacePage>;
  fetchAgentHistory: (
    options: Pick<FetchAgentHistoryOptions, "workspaceId" | "filter" | "page">,
  ) => Promise<ProjectArchiveAgentPage>;
}

interface ProjectArchiveHostClient extends ProjectArchiveHost {
  client: ProjectArchiveDiscoveryClient;
}

/** Resolve the full catalog by exact host/project identity even when host filters narrowed the row. */
export function resolveProjectArchiveHosts(input: {
  hosts: readonly ProjectArchiveHost[];
  projects: readonly WorkspaceStructureProject[];
}): ProjectArchiveHost[] {
  return input.projects
    .filter((project) =>
      project.hosts.some((host) =>
        input.hosts.some(
          (target) => target.serverId === host.serverId && target.projectId === host.projectId,
        ),
      ),
    )
    .flatMap((project) => project.hosts);
}

/** Reject an incomplete host set before discovery or mutations; never silently narrow the scope. */
function requireProjectArchiveClients(input: {
  hosts: readonly ProjectArchiveHost[];
  getClient: (serverId: string) => ProjectArchiveDiscoveryClient | null;
  supportsArchive: (serverId: string) => boolean;
}): ProjectArchiveHostClient[] {
  const clients: ProjectArchiveHostClient[] = [];
  const seen = new Set<string>();
  for (const host of input.hosts) {
    const key = JSON.stringify([host.serverId, host.projectId]);
    if (seen.has(key)) continue;
    seen.add(key);
    const client = input.getClient(host.serverId);
    if (!client) {
      throw new Error(i18n.t("sidebar.project.archive.hostDisconnected", { host: host.serverId }));
    }
    if (!input.supportsArchive(host.serverId)) {
      throw new Error(i18n.t("sidebar.project.archive.updateRequired", { host: host.serverId }));
    }
    clients.push({ ...host, client });
  }
  return clients;
}

/** Read every page without subscriptions or replacing the app's canonical directory caches. */
async function discoverHostWorkspaces(
  host: ProjectArchiveHostClient,
): Promise<ProjectArchiveWorkspace[]> {
  const workspaces = new Map<string, WorkspaceDescriptorPayload>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await host.client.fetchWorkspaces({
      filter: { projectId: host.projectId, includeBackground: true },
      page: { limit: 200, cursor },
    });
    for (const workspace of page.entries) {
      // The host/project pair is authoritative; names, paths and sidebar rows are not ownership.
      if (workspace.projectId === host.projectId) workspaces.set(workspace.id, workspace);
    }
    cursor = nextPageCursor(page.pageInfo, cursors);
  } while (cursor);

  const entries = new Map<string, ProjectArchiveWorkspace>();
  for (const workspace of workspaces.values()) {
    if (workspace.archivingAt) {
      throw new Error(
        i18n.t("sidebar.project.archive.alreadyArchiving", { workspace: workspace.name }),
      );
    }
    entries.set(workspace.id, {
      serverId: host.serverId,
      workspaceId: workspace.id,
      workspaceKind: workspace.workspaceKind,
      name: workspace.name,
      background: workspace.background === true,
      archiveHasUncommittedChanges: workspace.gitRuntime?.isDirty ?? null,
      archiveUnpushedCommitCount: workspace.gitRuntime?.aheadOfOrigin ?? null,
      diffStat: workspace.diffStat ?? null,
      agentIds: [],
      runningAgentCount: 0,
    });
  }

  for (const agent of await listUnarchivedProjectAgents(host.client)) {
    const workspace = agent.workspaceId ? entries.get(agent.workspaceId) : undefined;
    if (!workspace) continue;
    workspace.agentIds.push(agent.id);
    if (agent.status === "running" || agent.status === "initializing") {
      workspace.runningAgentCount += 1;
    }
  }

  return [...entries.values()];
}

/**
 * History includes durable agents whose provider is unavailable, and agents in archived workspaces.
 * The active directory omits both, so it cannot prove archive contents or postconditions.
 */
export async function listUnarchivedProjectAgents(
  client: Pick<ProjectArchiveDiscoveryClient, "fetchAgentHistory">,
  workspaceId?: string,
): Promise<ProjectArchiveAgentEntry["agent"][]> {
  const agents = new Map<string, ProjectArchiveAgentEntry["agent"]>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.fetchAgentHistory({
      workspaceId,
      filter: { includeArchived: false, includeBackground: true },
      page: { limit: 200, cursor },
    });
    for (const { agent } of page.entries) {
      if (!agent.archivedAt) agents.set(agent.id, agent);
    }
    cursor = nextPageCursor(page.pageInfo, cursors);
  } while (cursor);
  return [...agents.values()];
}

/** An incomplete or repeating page must fail before the user sees misleading counts. */
function nextPageCursor(
  page: { hasMore: boolean; nextCursor: string | null },
  seen: Set<string>,
): string | undefined {
  if (!page.hasMore) return undefined;
  if (!page.nextCursor || seen.has(page.nextCursor)) {
    throw new Error(i18n.t("sidebar.project.archive.incompleteDiscovery"));
  }
  seen.add(page.nextCursor);
  return page.nextCursor;
}

/** Discover the complete active project across all its hosts, including hidden background work. */
export async function discoverProjectArchiveWorkspaces(input: {
  hosts: readonly ProjectArchiveHost[];
  getClient: (serverId: string) => ProjectArchiveDiscoveryClient | null;
  supportsArchive: (serverId: string) => boolean;
}): Promise<ProjectArchiveWorkspace[]> {
  const clients = requireProjectArchiveClients(input);
  const workspaces: ProjectArchiveWorkspace[] = [];
  for (const host of clients) {
    workspaces.push(...(await discoverHostWorkspaces(host)));
  }
  return workspaces;
}
