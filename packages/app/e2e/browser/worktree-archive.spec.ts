import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { Page, TestInfo, WebSocket } from "@playwright/test";
import type { SessionInboundMessage, SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  archiveWorkspaceFromDaemon,
  archiveLocalWorkspaceFromDaemon,
  connectNewWorkspaceDaemonClient,
  createWorktreeViaDaemon,
  openProjectViaDaemon,
} from "../support/helpers/new-workspace";
import { projectEquivalenceViewKey } from "../support/helpers/project-view-key";
import { restoreArchivedWorkspace } from "../support/helpers/workspace-recovery";
import { getServerId } from "../support/helpers/server-id";
import {
  archiveWorkspaceFromSidebar,
  expectWorkspaceAbsentFromSidebar,
} from "../support/helpers/sidebar";
import { createTempGitRepo } from "../support/helpers/workspace";
import {
  waitForSidebarHydration,
  waitForWorkspaceInSidebar,
} from "../support/helpers/workspace-ui";

type ArchiveClient = Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;
type ArchivedWorktree = Awaited<ReturnType<typeof createWorktreeViaDaemon>> & { branch: string };
interface RecoveryFrame {
  direction: "sent" | "received";
  message: SessionInboundMessage | SessionOutboundMessage;
}

/** Observe real lifecycle exchanges without replacing a WebSocket or its responses. */
function recordRecoveryFrames(page: Page) {
  const frames: RecoveryFrame[] = [];
  const releases: Array<() => void> = [];
  const observeSocket = (socket: WebSocket) => {
    const record = (direction: RecoveryFrame["direction"], payload: string | Buffer) => {
      try {
        const envelope = JSON.parse(payload.toString()) as {
          type: string;
          message?: RecoveryFrame["message"];
        };
        const message = envelope.message;
        if (
          envelope.type === "session" &&
          message &&
          (message.type.startsWith("workspace.recovery.") ||
            message.type === "refresh_agent_request")
        ) {
          frames.push({ direction, message });
        }
      } catch {
        // Binary terminal frames are outside this recovery observation.
      }
    };
    const sent = ({ payload }: { payload: string | Buffer }) => record("sent", payload);
    const received = ({ payload }: { payload: string | Buffer }) => record("received", payload);
    socket.on("framesent", sent);
    socket.on("framereceived", received);
    releases.push(() => {
      socket.off("framesent", sent);
      socket.off("framereceived", received);
    });
  };
  page.on("websocket", observeSocket);
  return {
    frames,
    stop: () => {
      page.off("websocket", observeSocket);
      for (const release of releases) release();
    },
  };
}

/** Capture the real saved branch before archive removes the managed checkout. */
async function createRecoveryWorktree(
  client: ArchiveClient,
  repoPath: string,
  slug: string,
): Promise<ArchivedWorktree> {
  const workspace = await createWorktreeViaDaemon(client, { cwd: repoPath, slug });
  const branch = readCheckoutBranch(workspace.workspaceDirectory);
  expect(branch).not.toBe("");
  return { ...workspace, branch };
}

function readCheckoutBranch(directory: string): string {
  return execFileSync("git", ["branch", "--show-current"], {
    cwd: directory,
    encoding: "utf8",
  }).trim();
}

/** Use the project's overflow entry so this journey exercises the new discovery path. */
async function openArchiveChooser(page: Page, projectKey: string) {
  const viewKey = projectEquivalenceViewKey(projectKey);
  await page
    .getByTestId(`sidebar-project-row-${viewKey}`)
    .filter({ visible: true })
    .first()
    .hover();
  await page
    .getByTestId(`sidebar-project-kebab-${viewKey}`)
    .filter({ visible: true })
    .first()
    .click();
  await page
    .getByTestId(`sidebar-project-menu-restore-${viewKey}`)
    .filter({ visible: true })
    .first()
    .click();
  const chooser = page.getByTestId("restore-project-workspace-dialog");
  await expect(chooser).toBeVisible();
  return chooser;
}

function restoreRequests(frames: RecoveryFrame[], workspaceId: string) {
  return frames
    .filter((frame) => frame.direction === "sent")
    .map((frame) => frame.message)
    .filter((message) => message.type === "workspace.recovery.restore.request")
    .filter((message) => message.workspaceId === workspaceId);
}

/** Select a row without mutation, then explicitly restore through the existing confirmation. */
async function confirmWorktreeRecovery(input: {
  page: Page;
  client: ArchiveClient;
  workspace: ArchivedWorktree;
  frames: RecoveryFrame[];
  info: TestInfo;
}) {
  const { page, client, workspace, frames, info } = input;
  expect(restoreRequests(frames, workspace.workspaceId)).toEqual([]);
  await page.getByTestId(`restore-project-workspace-${workspace.workspaceId}`).click();
  await expect(page.getByTestId("restore-project-workspace-dialog")).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/workspace/${workspace.workspaceId}(?:\\?|$)`));
  await expect(page.getByText("Workspace archived", { exact: true })).toBeVisible();
  await expect(
    page.getByText(`Its worktree will use branch ${workspace.branch}.`, { exact: false }),
  ).toBeVisible();
  await expect(page.getByTestId("workspace-recovery-action")).toHaveText("Restore");
  expect(await client.inspectWorkspaceRecovery(workspace.workspaceId)).toMatchObject({
    kind: "recoverable",
    action: "restore",
    branch: workspace.branch,
  });
  expect(
    (await client.fetchWorkspaces()).entries.some((entry) => entry.id === workspace.workspaceId),
  ).toBe(false);
  expect(existsSync(workspace.workspaceDirectory)).toBe(false);
  expect(restoreRequests(frames, workspace.workspaceId)).toEqual([]);
  await info.attach(`recovery-confirmation-${workspace.workspaceId}`, {
    body: await page.screenshot(),
    contentType: "image/png",
  });

  await restoreArchivedWorkspace(page);
  await waitForWorkspaceInSidebar(page, {
    serverId: getServerId(),
    workspaceId: workspace.workspaceId,
  });
  await expect
    .poll(async () =>
      (await client.fetchWorkspaces()).entries.find((entry) => entry.id === workspace.workspaceId),
    )
    .toMatchObject({ id: workspace.workspaceId, projectId: workspace.projectId });
  expect(existsSync(workspace.workspaceDirectory)).toBe(true);
  expect(readCheckoutBranch(workspace.workspaceDirectory)).toBe(workspace.branch);
  const requests = restoreRequests(frames, workspace.workspaceId);
  expect(requests).toHaveLength(1);
  await expect
    .poll(
      () =>
        frames
          .map((frame) => frame.message)
          .filter((message) => message.type === "workspace.recovery.restore.response")
          .find((message) => message.payload.requestId === requests[0]?.requestId)?.payload,
    )
    .toMatchObject({ workspaceId: workspace.workspaceId, accepted: true, error: null });
}

/** Archive this case's tracked worktrees before removing projects and checking for remaining resources. */
async function cleanupRecoveryCase(input: {
  client: ArchiveClient;
  projectIds: Set<string>;
  directories: Set<string>;
  otherRepo: { cleanup: () => Promise<void> } | undefined;
  info: TestInfo;
  failed: boolean;
}) {
  const errors: string[] = [];
  // Project removal archives records but does not remove their backing worktrees.
  for (const directory of input.directories) {
    if (!existsSync(directory)) continue;
    try {
      await archiveWorkspaceFromDaemon(input.client, directory, { scope: "worktree" });
    } catch (error) {
      errors.push(`${directory}: ${String(error)}`);
    }
  }

  for (const projectId of input.projectIds) {
    try {
      await input.client.removeProject(projectId);
    } catch (error) {
      errors.push(`${projectId}: ${String(error)}`);
    }
  }
  try {
    const projects = (await input.client.listProjects()).projects.filter((project) =>
      input.projectIds.has(project.projectId),
    );
    const workspaces = (await input.client.fetchWorkspaces()).entries.filter((workspace) =>
      input.projectIds.has(workspace.projectId),
    );
    const directories = [...input.directories].filter((directory) => existsSync(directory));
    if (projects.length || workspaces.length || directories.length)
      errors.push("Fixture resources remained after project removal");
    await input.info.attach("recovery-fixture-cleanup", {
      body: JSON.stringify(
        { projectIds: [...input.projectIds], projects, workspaces, directories, errors },
        null,
        2,
      ),
      contentType: "application/json",
    });
  } catch (error) {
    errors.push(`Inventory: ${String(error)}`);
  }
  try {
    await input.otherRepo?.cleanup();
  } catch (error) {
    errors.push(`Other repository: ${String(error)}`);
  }
  if (errors.length) {
    await input.info.attach("recovery-cleanup-errors", {
      body: errors.join("\n"),
      contentType: "text/plain",
    });
    if (!input.failed) throw new Error(errors.join("\n"));
  }
}

interface RecoveryResources {
  projectIds: Set<string>;
  directories: Set<string>;
  otherRepo?: Awaited<ReturnType<typeof createTempGitRepo>>;
}

/** Build durable archive records through real daemon actions, tracking resources before fallible UI work. */
async function prepareRecoveryCase(
  client: ArchiveClient,
  repoPath: string,
  resources: RecoveryResources,
  createdWorktreeDirectories: Set<string>,
) {
  const project = await openProjectViaDaemon(client, repoPath);
  resources.projectIds.add(project.projectId);
  const zeroAgent = await createRecoveryWorktree(client, repoPath, `archive-empty-${Date.now()}`);
  resources.directories.add(zeroAgent.workspaceDirectory);
  createdWorktreeDirectories.add(zeroAgent.workspaceDirectory);
  const withAgent = await createRecoveryWorktree(client, repoPath, `archive-agent-${Date.now()}`);
  resources.directories.add(withAgent.workspaceDirectory);
  createdWorktreeDirectories.add(withAgent.workspaceDirectory);
  const agent = await client.createAgent({
    provider: "mock",
    cwd: withAgent.workspaceDirectory,
    workspaceId: withAgent.workspaceId,
    title: "Remain archived",
    modeId: "load-test",
    model: "e2e-fast-stream",
  });
  await client.archiveAgent(agent.id);
  await archiveLocalWorkspaceFromDaemon(client, zeroAgent.workspaceId);
  await archiveLocalWorkspaceFromDaemon(client, withAgent.workspaceId);
  await expect
    .poll(() => [...resources.directories].some((directory) => existsSync(directory)))
    .toBe(false);
  const archivedAt = (await client.fetchAgent({ agentId: agent.id }))?.agent.archivedAt;
  expect(archivedAt).toBeTruthy();
  expect(
    (
      await client.fetchAgentHistory({
        workspaceId: zeroAgent.workspaceId,
        filter: { includeArchived: true },
      })
    ).entries,
  ).toEqual([]);

  const otherRepo = await createTempGitRepo("archive-other-project-");
  resources.otherRepo = otherRepo;
  const otherProject = await openProjectViaDaemon(client, otherRepo.path);
  resources.projectIds.add(otherProject.projectId);
  const sentinel = await client.createWorkspace({
    source: { kind: "directory", path: otherRepo.path, projectId: otherProject.projectId },
    title: "Other project archived sentinel",
  });
  expect(sentinel.error).toBeNull();
  if (!sentinel.workspace) throw new Error("Missing other-project sentinel workspace");
  expect(sentinel.workspace.id).not.toBe(otherProject.workspaceId);
  await archiveLocalWorkspaceFromDaemon(client, sentinel.workspace.id);

  return { project, zeroAgent, withAgent, agent, archivedAt, sentinelId: sentinel.workspace.id };
}

type RecoveryFixture = Awaited<ReturnType<typeof prepareRecoveryCase>>;

/** Verify project-only discovery and its actual correlated reply before any recovery is requested. */
async function inspectInitialArchiveChooser(
  page: Page,
  fixture: RecoveryFixture,
  frames: RecoveryFrame[],
  info: TestInfo,
) {
  const { project, zeroAgent, withAgent, sentinelId } = fixture;
  await gotoAppShell(page);
  await waitForSidebarHydration(page);
  await waitForWorkspaceInSidebar(page, {
    serverId: getServerId(),
    workspaceId: project.workspaceId,
  });
  const chooser = await openArchiveChooser(page, project.projectKey);
  await expect(
    chooser.getByTestId(`restore-project-workspace-${zeroAgent.workspaceId}`),
  ).toBeVisible();
  await expect(
    chooser.getByTestId(`restore-project-workspace-${withAgent.workspaceId}`),
  ).toBeVisible();
  await expect(chooser.getByTestId(`restore-project-workspace-${project.workspaceId}`)).toHaveCount(
    0,
  );
  await expect(chooser.getByTestId(`restore-project-workspace-${sentinelId}`)).toHaveCount(0);
  const initialListRequests = frames
    .map((frame) => frame.message)
    .filter((message) => message.type === "workspace.recovery.list_archived.request");
  const listRequest = initialListRequests.at(-1);
  expect(listRequest?.projectId).toBe(project.projectId);
  const listResponse = frames
    .map((frame) => frame.message)
    .filter((message) => message.type === "workspace.recovery.list_archived.response")
    .find((message) => message.payload.requestId === listRequest?.requestId);
  expect(listResponse?.payload.error).toBeNull();
  expect(listResponse?.payload.entries.map((entry) => entry.workspaceId).sort()).toEqual(
    [zeroAgent.workspaceId, withAgent.workspaceId].sort(),
  );
  await info.attach("project-archive-chooser", {
    body: await page.screenshot(),
    contentType: "image/png",
  });

  return initialListRequests.length;
}

/** Run the two explicit restores against real fixture state, preserving failure and cleanup evidence. */
async function exerciseProjectArchiveRecovery({
  page,
  client,
  repoPath,
  createdWorktreeDirectories,
  info,
}: {
  page: Page;
  client: ArchiveClient;
  repoPath: string;
  createdWorktreeDirectories: Set<string>;
  info: TestInfo;
}) {
  expect(info.retry).toBe(0);
  const wire = recordRecoveryFrames(page);
  const resources: RecoveryResources = { projectIds: new Set(), directories: new Set() };
  let failed = false;
  try {
    const fixture = await prepareRecoveryCase(
      client,
      repoPath,
      resources,
      createdWorktreeDirectories,
    );
    const { project, zeroAgent, withAgent, agent, archivedAt } = fixture;
    const initialListRequestCount = await inspectInitialArchiveChooser(
      page,
      fixture,
      wire.frames,
      info,
    );

    await confirmWorktreeRecovery({
      page,
      client,
      workspace: zeroAgent,
      frames: wire.frames,
      info,
    });
    expect(
      (
        await client.fetchAgentHistory({
          workspaceId: zeroAgent.workspaceId,
          filter: { includeArchived: true },
        })
      ).entries,
    ).toEqual([]);
    expect((await client.fetchAgent({ agentId: agent.id }))?.agent.archivedAt).toBe(archivedAt);
    const refreshedChooser = await openArchiveChooser(page, project.projectKey);
    await expect(
      refreshedChooser.getByTestId(`restore-project-workspace-${withAgent.workspaceId}`),
    ).toBeVisible();
    await expect(
      refreshedChooser.getByTestId(`restore-project-workspace-${zeroAgent.workspaceId}`),
    ).toHaveCount(0);
    const refreshedListRequests = wire.frames
      .map((frame) => frame.message)
      .filter((message) => message.type === "workspace.recovery.list_archived.request");
    expect(refreshedListRequests.length).toBeGreaterThan(initialListRequestCount);
    expect(refreshedListRequests.every((request) => request.projectId === project.projectId)).toBe(
      true,
    );
    await confirmWorktreeRecovery({
      page,
      client,
      workspace: withAgent,
      frames: wire.frames,
      info,
    });
    expect((await client.fetchAgent({ agentId: agent.id }))?.agent.archivedAt).toBe(archivedAt);
    expect((await client.fetchAgents()).entries.some((entry) => entry.agent.id === agent.id)).toBe(
      false,
    );
    expect(
      wire.frames.filter(
        (frame) => frame.direction === "sent" && frame.message.type === "refresh_agent_request",
      ),
    ).toEqual([]);
    await info.attach("restored-workspace", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await info.attach("archived-agent-after-restore", {
      body: JSON.stringify({ agentId: agent.id, archivedAt }),
      contentType: "application/json",
    });
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    wire.stop();
    try {
      await info.attach("workspace-recovery-wire", {
        body: JSON.stringify(wire.frames, null, 2),
        contentType: "application/json",
      });
    } finally {
      await cleanupRecoveryCase({
        client,
        ...resources,
        otherRepo: resources.otherRepo,
        info,
        failed,
      });
    }
  }
}

test.describe("Workspace archive with worktree backing", () => {
  let client: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;
  let tempRepo: { path: string; cleanup: () => Promise<void> };
  const createdWorktreeDirectories = new Set<string>();

  test.describe.configure({ retries: 1, timeout: 120_000 });

  test.beforeEach(async () => {
    client = await connectNewWorkspaceDaemonClient();
    tempRepo = await createTempGitRepo("wt-archive-");
  });

  test.afterEach(async () => {
    for (const directory of createdWorktreeDirectories) {
      await archiveWorkspaceFromDaemon(client, directory).catch(() => undefined);
    }
    createdWorktreeDirectories.clear();
    await client?.close().catch(() => undefined);
    await tempRepo?.cleanup().catch(() => undefined);
  });

  test("a managed worktree remains until its last workspace is archived", async ({ page }) => {
    const serverId = getServerId();
    await openProjectViaDaemon(client, tempRepo.path);
    const first = await createWorktreeViaDaemon(client, {
      cwd: tempRepo.path,
      slug: `shared-archive-${Date.now()}`,
    });
    createdWorktreeDirectories.add(first.workspaceDirectory);

    const siblingPayload = await client.createWorkspace({
      source: {
        kind: "directory",
        path: first.workspaceDirectory,
      },
      title: "Second workspace",
    });
    if (!siblingPayload.workspace) {
      throw new Error(siblingPayload.error ?? "Failed to create a workspace on the worktree");
    }
    const sibling = siblingPayload.workspace;
    expect(sibling.workspaceKind).toBe("worktree");
    expect(sibling.workspaceDirectory).toBe(first.workspaceDirectory);

    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await waitForWorkspaceInSidebar(page, { serverId, workspaceId: first.workspaceId });
    await waitForWorkspaceInSidebar(page, { serverId, workspaceId: sibling.id });

    await archiveWorkspaceFromSidebar(page, first.workspaceId);

    await expectWorkspaceAbsentFromSidebar(page, first.workspaceId);
    expect(existsSync(first.workspaceDirectory)).toBe(true);
    await waitForWorkspaceInSidebar(page, { serverId, workspaceId: sibling.id });

    await archiveWorkspaceFromSidebar(page, sibling.id);

    await expectWorkspaceAbsentFromSidebar(page, sibling.id);
    await expect.poll(() => existsSync(first.workspaceDirectory), { timeout: 30_000 }).toBe(false);
  });

  test.describe("Project archive recovery", () => {
    // Override the parent suite's retry so the planned one-case run cannot retry itself.
    test.describe.configure({ retries: 0, timeout: 120_000 });

    test("project archive chooser restores zero-agent worktrees and keeps archived agents archived", async ({
      page,
    }, info) => {
      await exerciseProjectArchiveRecovery({
        page,
        client,
        repoPath: tempRepo.path,
        createdWorktreeDirectories,
        info,
      });
    });
  });
});
