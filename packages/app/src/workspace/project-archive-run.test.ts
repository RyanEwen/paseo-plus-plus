import type { WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import { i18n } from "@/i18n/i18next";
import type { WorkspaceStructureProject } from "@/projects/workspace-structure";
import type { ProjectArchiveDiscoveryClient } from "./project-archive-discovery";
import { runProjectArchive, type ProjectArchiveRunPorts } from "./project-archive-run";
import type { ProjectArchiveWorkspace } from "./project-workspace-archive";

const EMPTY_PAGE = { hasMore: false, nextCursor: null, prevCursor: null };

function descriptor(input: Partial<WorkspaceDescriptorPayload> = {}): WorkspaceDescriptorPayload {
  return {
    id: "workspace-1",
    projectId: "project-a",
    projectDisplayName: "Project A",
    projectRootPath: "/repo",
    workspaceDirectory: "/repo/shared",
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: "main",
    status: "done",
    archivingAt: null,
    statusEnteredAt: null,
    activityAt: null,
    scripts: [],
    gitRuntime: null,
    githubRuntime: null,
    ...input,
  };
}

/** A host that lists fixed workspaces and no agents. */
function hostClient(workspaces: WorkspaceDescriptorPayload[]): ProjectArchiveDiscoveryClient {
  return {
    fetchWorkspaces: async () => ({ entries: workspaces, pageInfo: EMPTY_PAGE }),
    fetchAgentHistory: async () => ({ entries: [], pageInfo: EMPTY_PAGE }),
  };
}

function project(hosts: Array<{ serverId: string; projectId: string }>): WorkspaceStructureProject {
  return {
    viewKey: "project-view",
    projectKey: "project",
    projectName: "Paseo++",
    projectKind: "git",
    iconWorkingDir: "/repo",
    hosts: hosts.map((host) =>
      Object.assign({}, host, { iconWorkingDir: "/repo", worktreeSupport: "supported" as const }),
    ),
    workspaceKeys: [],
  };
}

/** In-memory ports for one project on host-a; tests override what they exercise. */
function runPorts(overrides: Partial<ProjectArchiveRunPorts<ProjectArchiveDiscoveryClient>> = {}) {
  const archived: string[] = [];
  const confirmations: Array<{ workspaceIds: string[]; hostCount: number }> = [];
  const ports: ProjectArchiveRunPorts<ProjectArchiveDiscoveryClient> = {
    requestedHosts: [{ serverId: "host-a", projectId: "project-a" }],
    readProjects: () => [project([{ serverId: "host-a", projectId: "project-a" }])],
    getClient: () => hostClient([descriptor()]),
    supportsArchive: () => true,
    isActive: () => true,
    confirm: async (request) => {
      confirmations.push({
        workspaceIds: request.workspaces.map((workspace) => workspace.workspaceId),
        hostCount: request.hostCount,
      });
      return { kind: "confirmed", includeBackground: false };
    },
    archiveWorkspace: async (_client, workspace: ProjectArchiveWorkspace) => {
      archived.push(workspace.workspaceId);
    },
    onProgress: () => {},
    ...overrides,
  };
  return { ports, archived, confirmations };
}

describe("runProjectArchive", () => {
  it("confirms the discovered workspaces with the host count, then archives them", async () => {
    const { ports, archived, confirmations } = runPorts();
    expect(await runProjectArchive(ports)).toEqual({ kind: "archived", archivedCount: 1 });
    expect(confirmations).toEqual([{ workspaceIds: ["workspace-1"], hostCount: 1 }]);
    expect(archived).toEqual(["workspace-1"]);
  });

  it("reports an empty project without asking the user", async () => {
    const { ports, confirmations } = runPorts({ getClient: () => hostClient([]) });
    expect(await runProjectArchive(ports)).toEqual({ kind: "empty" });
    expect(confirmations).toEqual([]);
  });

  it("stops without asking once the owner has gone away during discovery", async () => {
    const { ports, confirmations, archived } = runPorts({ isActive: () => false });
    expect(await runProjectArchive(ports)).toEqual({ kind: "aborted" });
    expect(confirmations).toEqual([]);
    expect(archived).toEqual([]);
  });

  it("reports a project that no longer matches its row as an error", async () => {
    const { ports } = runPorts({ readProjects: () => [] });
    expect(await runProjectArchive(ports)).toEqual({
      kind: "error",
      error: new Error(i18n.t("sidebar.project.archive.projectChanged")),
    });
  });

  it("archives nothing when the project's host set changes during confirmation", async () => {
    let reads = 0;
    const { ports, archived } = runPorts({
      readProjects: () => {
        reads += 1;
        const hosts = [{ serverId: "host-a", projectId: "project-a" }];
        if (reads > 1) hosts.push({ serverId: "host-b", projectId: "project-b" });
        return [project(hosts)];
      },
    });
    expect(await runProjectArchive(ports)).toEqual({
      kind: "error",
      error: new Error(i18n.t("sidebar.project.archive.projectChanged")),
    });
    expect(archived).toEqual([]);
  });

  it("stops the batch when a host disconnects before its workspace is archived", async () => {
    let clientReads = 0;
    const { ports, archived } = runPorts({
      getClient: () => {
        clientReads += 1;
        // Discovery and the refresh read the client; the archive step finds it gone.
        return clientReads <= 2 ? hostClient([descriptor()]) : null;
      },
    });
    expect(await runProjectArchive(ports)).toMatchObject({
      kind: "failed",
      archivedCount: 0,
      unprocessedCount: 0,
      error: new Error(i18n.t("sidebar.project.archive.hostDisconnected", { host: "host-a" })),
    });
    expect(archived).toEqual([]);
  });
});
