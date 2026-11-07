import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { i18n } from "@/i18n/i18next";
import type { WorkspaceStructureProject } from "@/projects/workspace-structure";
import { getLastWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { redirectIfArchivingActiveWorkspace } from "@/utils/sidebar-workspace-archive-redirect";
import {
  discoverProjectArchiveWorkspaces,
  resolveProjectArchiveHosts,
  type ProjectArchiveDiscoveryClient,
  type ProjectArchiveHost,
} from "./project-archive-discovery";
import { verifyProjectWorkspaceArchive } from "./project-archive-verification";
import {
  archiveProjectWorkspaces,
  projectArchiveHostKey,
  type ProjectArchiveConfirmation,
  type ProjectArchiveOutcome,
  type ProjectArchiveWorkspace,
} from "./project-workspace-archive";
import { archiveWorkspaceOptimistically } from "./workspace-archive";
import { purgeArchivedWorkspaceState } from "./workspace-archive-layout";

const CANCELLED: ProjectArchiveConfirmation = { kind: "cancelled" };

/** How Archive all ended, for the owner to report. */
export type ProjectArchiveRunResult =
  | ProjectArchiveOutcome
  /** The owner went away while discovery ran; nothing was confirmed or changed. */
  | { kind: "aborted" }
  /** The project has no active workspaces on its hosts. */
  | { kind: "empty" }
  /** Discovery, confirmation or the host check failed before any result. */
  | { kind: "error"; error: unknown };

/** What Archive all needs from the app: hosts, clients, the user, and the archive itself. */
export interface ProjectArchiveRunPorts<TClient extends ProjectArchiveDiscoveryClient> {
  /** The host/project pairs the sidebar row shows. */
  requestedHosts: readonly ProjectArchiveHost[];
  /** Current sidebar projects; read again before archiving to catch a changed host set. */
  readProjects: () => readonly WorkspaceStructureProject[];
  /** The host's client while it is connected, otherwise null. */
  getClient: (serverId: string) => TClient | null;
  supportsArchive: (serverId: string) => boolean;
  /** False once the owner has unmounted; later steps then stop without asking the user. */
  isActive: () => boolean;
  /** Ask the user to confirm the discovered workspaces, with the background choice. */
  confirm: (request: {
    workspaces: ProjectArchiveWorkspace[];
    hostCount: number;
  }) => Promise<ProjectArchiveConfirmation>;
  /** Archive one confirmed workspace; reject to stop the batch. */
  archiveWorkspace: (client: TClient, workspace: ProjectArchiveWorkspace) => Promise<void>;
  onProgress: (completed: number, total: number) => void;
}

/** Resolve the full host set by exact project identity; an empty set means the project changed. */
function resolveRunHosts<TClient extends ProjectArchiveDiscoveryClient>(
  ports: ProjectArchiveRunPorts<TClient>,
): ProjectArchiveHost[] {
  const hosts = resolveProjectArchiveHosts({
    hosts: ports.requestedHosts,
    projects: ports.readProjects(),
  });
  if (hosts.length === 0) {
    throw new Error(i18n.t("sidebar.project.archive.projectChanged"));
  }
  return hosts;
}

/** Reject a host set that changed while the user was confirming. */
function requireSameHosts(expected: readonly ProjectArchiveHost[], observed: ProjectArchiveHost[]) {
  const expectedKeys = JSON.stringify(expected.map(projectArchiveHostKey).sort());
  const observedKeys = JSON.stringify(observed.map(projectArchiveHostKey).sort());
  if (expectedKeys !== observedKeys) {
    throw new Error(i18n.t("sidebar.project.archive.projectChanged"));
  }
}

async function runProjectArchiveSteps<TClient extends ProjectArchiveDiscoveryClient>(
  ports: ProjectArchiveRunPorts<TClient>,
): Promise<ProjectArchiveRunResult> {
  // Phase 1: discover every host's active workspaces and agents.
  const hosts = resolveRunHosts(ports);
  const discover = () =>
    discoverProjectArchiveWorkspaces({
      hosts,
      getClient: ports.getClient,
      supportsArchive: ports.supportsArchive,
    });
  const workspaces = await discover();
  if (!ports.isActive()) {
    return { kind: "aborted" };
  }
  if (workspaces.length === 0) {
    return { kind: "empty" };
  }

  // Phase 2: confirm, recheck, then archive serially (archiveProjectWorkspaces owns the policy).
  return archiveProjectWorkspaces({
    workspaces,
    confirm: async (entries) =>
      ports.isActive() ? ports.confirm({ workspaces: entries, hostCount: hosts.length }) : CANCELLED,
    refresh: async () => {
      requireSameHosts(hosts, resolveRunHosts(ports));
      return discover();
    },
    archive: async (workspace) => {
      const client = ports.getClient(workspace.serverId);
      if (!client) {
        throw new Error(
          i18n.t("sidebar.project.archive.hostDisconnected", { host: workspace.serverId }),
        );
      }
      await ports.archiveWorkspace(client, workspace);
    },
    onProgress: ports.onProgress,
  });
}

/**
 * Run Archive all for one project row. Never rejects: failures before the batch come back as
 * `{ kind: "error" }`, and a failure inside the batch as the `failed` outcome.
 */
export async function runProjectArchive<TClient extends ProjectArchiveDiscoveryClient>(
  ports: ProjectArchiveRunPorts<TClient>,
): Promise<ProjectArchiveRunResult> {
  try {
    return await runProjectArchiveSteps(ports);
  } catch (error) {
    return { kind: "error", error };
  }
}

/**
 * The live archive step: hide the workspace optimistically, archive it on the host, verify the
 * durable state, then drop its tabs and leave the route if it was open.
 */
export async function archiveConfirmedProjectWorkspace(
  client: DaemonClient,
  workspace: ProjectArchiveWorkspace,
): Promise<void> {
  await archiveWorkspaceOptimistically({ client, workspace });
  await verifyProjectWorkspaceArchive({ client, workspace });
  purgeArchivedWorkspaceState(workspace);
  redirectIfArchivingActiveWorkspace({
    ...workspace,
    activeWorkspaceSelection: getLastWorkspaceSelection(),
  });
}
