import { describe, expect, it, vi } from "vitest";
import {
  archiveProjectWorkspaces,
  buildProjectArchiveConfirmation,
  selectProjectArchiveScope,
  selectProjectWorkspacesToArchive,
  type ProjectArchiveWorkspace,
} from "@/workspace/project-workspace-archive";
import {
  discoverProjectArchiveWorkspaces,
  resolveProjectArchiveHosts,
  type ProjectArchiveDiscoveryClient,
} from "./project-archive-discovery";
import type { WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import { buildWorkspaceStructureProjects } from "@/projects/workspace-structure";
import {
  verifyProjectWorkspaceArchive,
  type ProjectArchiveVerificationClient,
} from "./project-archive-verification";

describe("selectProjectWorkspacesToArchive", () => {
  it("skips archiving a dirty and unpushed worktree when the risky archive confirmation is canceled", async () => {
    const confirmWorktreeArchive = vi.fn(async () => false);

    const targets = await selectProjectWorkspacesToArchive(
      [
        {
          serverId: "server-1",
          workspaceId: "workspace-worktree",
          workspaceKind: "worktree",
          name: "feature/risky",
          archiveHasUncommittedChanges: true,
          archiveUnpushedCommitCount: 2,
          diffStat: { additions: 5, deletions: 1 },
        },
        {
          serverId: "server-1",
          workspaceId: "workspace-checkout",
          workspaceKind: "local_checkout",
          name: "main",
          archiveHasUncommittedChanges: null,
          archiveUnpushedCommitCount: null,
          diffStat: null,
        },
      ],
      confirmWorktreeArchive,
    );

    expect(confirmWorktreeArchive).toHaveBeenCalledOnce();
    expect(confirmWorktreeArchive).toHaveBeenCalledWith({
      workspaceName: "feature/risky",
      isDirty: true,
      aheadOfOrigin: 2,
      diffStat: { additions: 5, deletions: 1 },
    });
    expect(targets).toEqual([
      {
        serverId: "server-1",
        workspaceId: "workspace-checkout",
      },
    ]);
  });

  it("includes a dirty and unpushed worktree when the risky archive confirmation is accepted", async () => {
    const confirmWorktreeArchive = vi.fn(async () => true);

    const targets = await selectProjectWorkspacesToArchive(
      [
        {
          serverId: "server-1",
          workspaceId: "workspace-worktree",
          workspaceKind: "worktree",
          name: "feature/risky",
          archiveHasUncommittedChanges: true,
          archiveUnpushedCommitCount: 2,
          diffStat: { additions: 5, deletions: 1 },
        },
        {
          serverId: "server-1",
          workspaceId: "workspace-checkout",
          workspaceKind: "local_checkout",
          name: "main",
          archiveHasUncommittedChanges: null,
          archiveUnpushedCommitCount: null,
          diffStat: null,
        },
      ],
      confirmWorktreeArchive,
    );

    expect(confirmWorktreeArchive).toHaveBeenCalledOnce();
    expect(confirmWorktreeArchive).toHaveBeenCalledWith({
      workspaceName: "feature/risky",
      isDirty: true,
      aheadOfOrigin: 2,
      diffStat: { additions: 5, deletions: 1 },
    });
    expect(targets).toEqual([
      {
        serverId: "server-1",
        workspaceId: "workspace-worktree",
      },
      {
        serverId: "server-1",
        workspaceId: "workspace-checkout",
      },
    ]);
  });
});

function archiveWorkspace(input: Partial<ProjectArchiveWorkspace> = {}): ProjectArchiveWorkspace {
  return {
    serverId: "host-a",
    workspaceId: "workspace-1",
    workspaceKind: "local_checkout",
    name: "main",
    background: false,
    agentIds: ["agent-1"],
    runningAgentCount: 1,
    archiveHasUncommittedChanges: null,
    archiveUnpushedCommitCount: null,
    diffStat: null,
    ...input,
  };
}

function archiveFlow(workspaces: ProjectArchiveWorkspace[]) {
  return {
    workspaces,
    confirm: vi.fn(async (): Promise<boolean | null> => false),
    confirmWorktreeArchive: vi.fn(async () => true),
    refresh: vi.fn(async () => workspaces),
    archive: vi.fn(async (_workspace: ProjectArchiveWorkspace) => {}),
    onProgress: vi.fn(),
  };
}

describe("project archive confirmation and execution", () => {
  it("identifies the project and affected workspace, agent, running and host counts", () => {
    const confirmation = buildProjectArchiveConfirmation({
      projectName: "Paseo++",
      hostCount: 2,
      selection: selectProjectArchiveScope(
        [
          archiveWorkspace(),
          archiveWorkspace({
            workspaceId: "empty-workspace",
            agentIds: [],
            runningAgentCount: 0,
          }),
        ],
        false,
      ),
    });
    expect(confirmation.destructive).toBe(true);
    expect(confirmation.message).toContain('Project: "Paseo++"');
    expect(confirmation.message).toContain("Workspaces: 2");
    expect(confirmation.message).toContain("Agents: 1 (running: 1)");
    expect(confirmation.message).toContain("Hosts: 2");
  });

  it("makes no mutation or risk prompt when the main confirmation is cancelled", async () => {
    const flow = archiveFlow([archiveWorkspace()]);
    flow.confirm.mockResolvedValue(null);
    expect(await archiveProjectWorkspaces(flow)).toEqual({ kind: "cancelled" });
    expect(flow.archive).not.toHaveBeenCalled();
    expect(flow.refresh).not.toHaveBeenCalled();
    expect(flow.confirmWorktreeArchive).not.toHaveBeenCalled();
  });

  it("leaves background work untouched unless explicitly selected", async () => {
    const workspaces = [
      archiveWorkspace(),
      archiveWorkspace({
        workspaceId: "background",
        background: true,
        agentIds: ["job-agent", "job-child"],
      }),
    ];
    const ordinary = archiveFlow(workspaces);
    expect(await archiveProjectWorkspaces(ordinary)).toEqual({
      kind: "archived",
      archivedCount: 1,
    });
    expect(ordinary.archive.mock.calls.map(([workspace]) => workspace.workspaceId)).toEqual([
      "workspace-1",
    ]);
    expect(selectProjectArchiveScope(workspaces, false).agentCount).toBe(1);

    const inclusive = archiveFlow(workspaces);
    inclusive.confirm.mockResolvedValue(true);
    expect(selectProjectArchiveScope(workspaces, true).agentCount).toBe(3);
    expect(await archiveProjectWorkspaces(inclusive)).toEqual({
      kind: "archived",
      archivedCount: 2,
    });
    expect(inclusive.archive.mock.calls.map(([workspace]) => workspace.workspaceId)).toEqual([
      "workspace-1",
      "background",
    ]);
  });

  it("cancelling a dirty/unpushed warning preserves the entire batch", async () => {
    const flow = archiveFlow([
      archiveWorkspace(),
      archiveWorkspace({
        workspaceId: "risky",
        workspaceKind: "worktree",
        archiveHasUncommittedChanges: true,
        archiveUnpushedCommitCount: 3,
      }),
    ]);
    flow.confirmWorktreeArchive.mockResolvedValue(false);
    expect(await archiveProjectWorkspaces(flow)).toEqual({ kind: "cancelled" });
    expect(flow.archive).not.toHaveBeenCalled();
    expect(flow.refresh).not.toHaveBeenCalled();
  });

  it.each(["membership", "agents", "running", "risk"])(
    "requires fresh confirmation if %s changes",
    async (change) => {
      const original = archiveWorkspace();
      const flow = archiveFlow([original]);
      const changed = { ...original };
      if (change === "membership") changed.workspaceId = "new-workspace";
      if (change === "agents") changed.agentIds = ["new-agent"];
      if (change === "running") changed.runningAgentCount = 0;
      if (change === "risk") changed.archiveHasUncommittedChanges = true;
      flow.refresh.mockResolvedValue([changed]);
      expect(await archiveProjectWorkspaces(flow)).toEqual({ kind: "changed" });
      expect(flow.archive).not.toHaveBeenCalled();
    },
  );

  it("archives serially and leaves failed and unprocessed targets available after a partial failure", async () => {
    const workspaces = [
      archiveWorkspace(),
      archiveWorkspace({ workspaceId: "failed" }),
      archiveWorkspace({ workspaceId: "unprocessed" }),
    ];
    const flow = archiveFlow(workspaces);
    const retained = new Set(workspaces.map((workspace) => workspace.workspaceId));
    let inFlight = 0;
    let maxInFlight = 0;
    flow.archive.mockImplementation(async (workspace) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      if (workspace.workspaceId === "failed") throw new Error("host disconnected");
      retained.delete(workspace.workspaceId);
    });

    const outcome = await archiveProjectWorkspaces(flow);
    expect(outcome).toMatchObject({
      kind: "failed",
      archivedCount: 1,
      failed: { workspaceId: "failed" },
      unprocessedCount: 1,
    });
    expect(flow.archive.mock.calls.map(([workspace]) => workspace.workspaceId)).toEqual([
      "workspace-1",
      "failed",
    ]);
    expect([...retained]).toEqual(["failed", "unprocessed"]);
    expect(maxInFlight).toBe(1);
    expect(flow.onProgress.mock.calls).toEqual([
      [0, 3],
      [1, 3],
    ]);
  });
});

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

function directoryClient() {
  const client = {
    fetchWorkspaces: vi.fn<ProjectArchiveDiscoveryClient["fetchWorkspaces"]>(async () => ({
      entries: [],
      pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
    })),
    fetchAgentHistory: vi.fn<ProjectArchiveDiscoveryClient["fetchAgentHistory"]>(async () => ({
      entries: [],
      pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
    })),
  };
  return client;
}

describe("project archive discovery", () => {
  it("uses exact catalog membership to recover hosts hidden by a local host filter", () => {
    const projects = buildWorkspaceStructureProjects({
      sessions: ["host-a", "host-b"].map((serverId) => ({
        serverId,
        workspaces: [],
        projects: [
          {
            projectId: `${serverId}-project`,
            projectKey: "shared-project",
            projectKind: "git",
            projectDisplayName: "Same name",
            projectCustomName: null,
            projectRootPath: "/repo",
          },
          {
            projectId: "unrelated",
            projectKey: "unrelated",
            projectKind: "git",
            projectDisplayName: "Same name",
            projectCustomName: null,
            projectRootPath: "/other",
          },
        ],
      })),
    });
    const hosts = resolveProjectArchiveHosts({
      hosts: [{ serverId: "host-a", projectId: "host-a-project" }],
      projects,
    });
    expect(hosts.map(({ serverId, projectId }) => ({ serverId, projectId }))).toEqual([
      { serverId: "host-a", projectId: "host-a-project" },
      { serverId: "host-b", projectId: "host-b-project" },
    ]);
  });

  it("discovers all pages, pinned and background workspaces once, isolating projects and host identities", async () => {
    const first = directoryClient();
    const second = directoryClient();
    first.fetchWorkspaces
      .mockResolvedValueOnce({
        entries: [
          descriptor({ pinnedAt: "2026-10-21T00:00:00Z" }),
          descriptor({ id: "foreign", projectId: "other-project" }),
        ],
        pageInfo: { hasMore: true, nextCursor: "workspaces-next", prevCursor: null },
      })
      .mockResolvedValueOnce({
        entries: [
          descriptor(),
          descriptor({ id: "hidden", background: true, projectPinnedAt: "2026-10-21T00:00:00Z" }),
        ],
        pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
      });
    first.fetchAgentHistory
      .mockResolvedValueOnce({
        entries: [
          { agent: { id: "root", workspaceId: "workspace-1", status: "running" } },
          { agent: { id: "foreign-agent", workspaceId: "foreign", status: "running" } },
        ],
        pageInfo: { hasMore: true, nextCursor: "agents-next", prevCursor: null },
      })
      .mockResolvedValueOnce({
        entries: [
          { agent: { id: "root", workspaceId: "workspace-1", status: "running" } },
          { agent: { id: "closed-child", workspaceId: "workspace-1", status: "closed" } },
          {
            agent: {
              id: "old",
              workspaceId: "workspace-1",
              status: "closed",
              archivedAt: "2026-10-20T00:00:00Z",
            },
          },
          { agent: { id: "background-job", workspaceId: "hidden", status: "idle" } },
        ],
        pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
      });
    second.fetchWorkspaces.mockResolvedValue({
      entries: [descriptor({ projectId: "project-b" })],
      pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
    });
    second.fetchAgentHistory.mockResolvedValue({
      entries: [{ agent: { id: "root", workspaceId: "workspace-1", status: "initializing" } }],
      pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
    });
    const entries = await discoverProjectArchiveWorkspaces({
      hosts: [
        { serverId: "host-a", projectId: "project-a" },
        { serverId: "host-b", projectId: "project-b" },
        { serverId: "host-a", projectId: "project-a" },
      ],
      getClient: (serverId) => (serverId === "host-a" ? first : second),
      supportsArchive: () => true,
    });
    expect(
      entries.map(({ serverId, workspaceId, agentIds, runningAgentCount, background }) => ({
        serverId,
        workspaceId,
        agentIds,
        runningAgentCount,
        background,
      })),
    ).toEqual([
      {
        serverId: "host-a",
        workspaceId: "workspace-1",
        agentIds: ["root", "closed-child"],
        runningAgentCount: 1,
        background: false,
      },
      {
        serverId: "host-a",
        workspaceId: "hidden",
        agentIds: ["background-job"],
        runningAgentCount: 0,
        background: true,
      },
      {
        serverId: "host-b",
        workspaceId: "workspace-1",
        agentIds: ["root"],
        runningAgentCount: 1,
        background: false,
      },
    ]);
    expect(first.fetchWorkspaces.mock.calls[1]?.[0]).toEqual({
      filter: { projectId: "project-a", includeBackground: true },
      page: { limit: 200, cursor: "workspaces-next" },
    });
    expect(first.fetchAgentHistory.mock.calls[1]?.[0].page?.cursor).toBe("agents-next");
    expect(selectProjectArchiveScope(entries, false).agentCount).toBe(3);
    expect(selectProjectArchiveScope(entries, true).agentCount).toBe(4);
  });

  it.each(["offline", "unsupported"])(
    "preflights every host before reading when a host is %s",
    async (condition) => {
      const first = directoryClient();
      await expect(
        discoverProjectArchiveWorkspaces({
          hosts: [
            { serverId: "host-a", projectId: "project-a" },
            { serverId: "host-b", projectId: "project-b" },
          ],
          getClient: (serverId) =>
            condition === "offline" && serverId === "host-b" ? null : first,
          supportsArchive: (serverId) => !(condition === "unsupported" && serverId === "host-b"),
        }),
      ).rejects.toThrow("host-b");
      expect(first.fetchWorkspaces).not.toHaveBeenCalled();
      expect(first.fetchAgentHistory).not.toHaveBeenCalled();
    },
  );

  it("rejects repeating pagination rather than confirming incomplete counts", async () => {
    const client = directoryClient();
    client.fetchWorkspaces.mockResolvedValue({
      entries: [],
      pageInfo: { hasMore: true, nextCursor: "repeated", prevCursor: null },
    });
    await expect(
      discoverProjectArchiveWorkspaces({
        hosts: [{ serverId: "host-a", projectId: "project-a" }],
        getClient: () => client,
        supportsArchive: () => true,
      }),
    ).rejects.toThrow("Could not count all");
    expect(client.fetchWorkspaces).toHaveBeenCalledTimes(2);
    expect(client.fetchAgentHistory).not.toHaveBeenCalled();
  });
});

function verificationClient() {
  return {
    fetchAgentHistory: directoryClient().fetchAgentHistory,
    inspectWorkspaceRecovery: vi.fn<ProjectArchiveVerificationClient["inspectWorkspaceRecovery"]>(
      async (workspaceId) => ({
        kind: "recoverable",
        workspaceId,
        workspaceName: "main",
        action: "unarchive",
        branch: "main",
      }),
    ),
    fetchAgent: vi.fn<ProjectArchiveVerificationClient["fetchAgent"]>(async (id) => ({
      agent: {
        id,
        workspaceId: "workspace-1",
        archivedAt: "2026-10-21T00:00:00Z",
        status: "closed",
      },
    })),
  };
}

describe("project archive authoritative postconditions", () => {
  it("verifies the archived workspace, orphan membership and each exact agent identity", async () => {
    const client = verificationClient();
    await verifyProjectWorkspaceArchive({ client, workspace: archiveWorkspace() });
    expect(client.inspectWorkspaceRecovery).toHaveBeenCalledWith("workspace-1");
    expect(client.fetchAgentHistory).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      filter: { includeArchived: false, includeBackground: true },
      page: { limit: 200, cursor: undefined },
    });
    expect(client.fetchAgent).toHaveBeenCalledWith("agent-1");
  });

  it("rejects an API acknowledgement when the workspace is still active", async () => {
    const client = verificationClient();
    client.inspectWorkspaceRecovery.mockResolvedValue({
      kind: "unavailable",
      workspaceId: "workspace-1",
      reason: "workspace_not_archived",
      message: "Still active",
    });
    await expect(
      verifyProjectWorkspaceArchive({ client, workspace: archiveWorkspace() }),
    ).rejects.toThrow("Could not verify");
  });

  it("detects active agents in an archived workspace through history instead of the active directory", async () => {
    const client = verificationClient();
    client.fetchAgentHistory.mockResolvedValue({
      entries: [{ agent: { id: "late-agent", workspaceId: "workspace-1", status: "idle" } }],
      pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
    });
    await expect(
      verifyProjectWorkspaceArchive({ client, workspace: archiveWorkspace() }),
    ).rejects.toThrow("still has active agents");
  });

  it.each(["missing", "unarchived", "running", "initializing"])(
    "stops when an exact confirmed agent is %s",
    async (condition) => {
      const client = verificationClient();
      let status: "running" | "initializing" | "closed" = "closed";
      if (condition === "running") status = "running";
      if (condition === "initializing") status = "initializing";
      client.fetchAgent.mockResolvedValue(
        condition === "missing"
          ? null
          : {
              agent: {
                id: "agent-1",
                workspaceId: "workspace-1",
                archivedAt: condition === "unarchived" ? null : "2026-10-21T00:00:00Z",
                status,
              },
            },
      );
      const flow = archiveFlow([
        archiveWorkspace(),
        archiveWorkspace({ workspaceId: "unprocessed" }),
      ]);
      flow.archive.mockImplementation(async (workspace) =>
        verifyProjectWorkspaceArchive({ client, workspace }),
      );
      expect(await archiveProjectWorkspaces(flow)).toMatchObject({
        kind: "failed",
        archivedCount: 0,
        unprocessedCount: 1,
      });
      expect(flow.archive).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["idle", "error", "closed"] as const)(
    "accepts archived stored snapshots retaining %s status",
    async (status) => {
      const client = verificationClient();
      client.fetchAgent.mockResolvedValue({
        agent: {
          id: "agent-1",
          workspaceId: "workspace-1",
          archivedAt: "2026-10-21T00:00:00Z",
          status,
        },
      });
      await expect(
        verifyProjectWorkspaceArchive({ client, workspace: archiveWorkspace() }),
      ).resolves.toBeUndefined();
    },
  );
});
