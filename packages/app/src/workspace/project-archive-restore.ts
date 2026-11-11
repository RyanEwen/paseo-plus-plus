import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ArchivedWorkspaceSummary } from "@getpaseo/protocol/messages";

/** One host a project is open on, as the sidebar project row aggregates it. */
export interface ProjectArchiveRestoreHost {
  serverId: string;
  projectId: string;
}

export type ArchivedWorkspaceListingClient = Pick<DaemonClient, "listArchivedProjectWorkspaces">;

/** How the chooser reaches each host. Adapters read the live host runtime and session store. */
export interface ArchivedWorkspaceListingPort {
  /** The host's client while it is connected, otherwise null. */
  getConnectedClient: (serverId: string) => ArchivedWorkspaceListingClient | null;
  /** Whether the host advertises project-scoped archive listings. */
  supportsListing: (serverId: string) => boolean;
}

/** What one host contributed to the chooser; each host settles on its own. */
export type ArchivedHostListing =
  | { kind: "disconnected"; serverId: string }
  | { kind: "unsupported"; serverId: string }
  | { kind: "loaded"; serverId: string; entries: ArchivedWorkspaceSummary[] }
  | { kind: "failed"; serverId: string; error: unknown };

export interface ArchivedWorkspaceRow {
  serverId: string;
  entry: ArchivedWorkspaceSummary;
}

/**
 * The hosts the restore chooser lists for a sidebar project row: every host the project is open
 * on, like Archive all, so no host's archive is silently left out.
 */
export function resolveProjectRestoreHosts(project: {
  hosts: readonly ProjectArchiveRestoreHost[];
}): ProjectArchiveRestoreHost[] {
  return [...project.hosts];
}

/** Load one host's archived records without letting its failure hide another host's. */
async function listHostArchivedWorkspaces(
  host: ProjectArchiveRestoreHost,
  includeBackground: boolean,
  port: ArchivedWorkspaceListingPort,
): Promise<ArchivedHostListing> {
  const client = port.getConnectedClient(host.serverId);
  if (!client) {
    return { kind: "disconnected", serverId: host.serverId };
  }
  // COMPAT(projectArchivedWorkspaces): added in v0.11.2, remove after 2027-04-20.
  if (!port.supportsListing(host.serverId)) {
    return { kind: "unsupported", serverId: host.serverId };
  }
  try {
    const entries = await client.listArchivedProjectWorkspaces({
      projectId: host.projectId,
      includeBackground,
    });
    return { kind: "loaded", serverId: host.serverId, entries };
  } catch (error) {
    return { kind: "failed", serverId: host.serverId, error };
  }
}

/**
 * List every host's archived workspace records for one project. Never rejects: each host's
 * outcome is reported so the chooser can show what it could not search.
 */
export async function listProjectArchivedWorkspaces(input: {
  hosts: readonly ProjectArchiveRestoreHost[];
  includeBackground: boolean;
  port: ArchivedWorkspaceListingPort;
}): Promise<ArchivedHostListing[]> {
  return Promise.all(
    input.hosts.map((host) =>
      listHostArchivedWorkspaces(host, input.includeBackground, input.port),
    ),
  );
}

function matchesArchivedWorkspaceQuery(entry: ArchivedWorkspaceSummary, query: string): boolean {
  return [entry.workspaceName, entry.branch, entry.workspaceDirectory].some((value) =>
    value?.toLocaleLowerCase().includes(query),
  );
}

/** Rows to show for a search, in host order, each tagged with the host that owns it. */
export function selectArchivedWorkspaceRows(
  listings: readonly ArchivedHostListing[],
  search: string,
): ArchivedWorkspaceRow[] {
  const query = search.trim().toLocaleLowerCase();
  const rows: ArchivedWorkspaceRow[] = [];
  for (const listing of listings) {
    if (listing.kind !== "loaded") {
      continue;
    }
    for (const entry of listing.entries) {
      if (matchesArchivedWorkspaceQuery(entry, query)) {
        rows.push({ serverId: listing.serverId, entry });
      }
    }
  }
  return rows;
}
