import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  archiveLocalWorkspaceFromDaemon,
  archiveWorkspaceFromDaemon,
  connectNewWorkspaceDaemonClient,
  createWorktreeViaDaemon,
  openProjectViaDaemon,
} from "../support/helpers/new-workspace";
import {
  openArchiveAllConfirmation,
  openArchiveChooser,
  recordRecoveryFrames,
  type RecoveryFrame,
} from "../support/helpers/project-archive";
import { getServerId } from "../support/helpers/server-id";
import { expectWorkspaceAbsentFromSidebar } from "../support/helpers/sidebar";
import { createTempGitRepo } from "../support/helpers/workspace";
import { restoreArchivedWorkspace } from "../support/helpers/workspace-recovery";
import {
  waitForSidebarHydration,
  waitForWorkspaceInSidebar,
} from "../support/helpers/workspace-ui";

type ArchiveClient = Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;
type ArchivedWorktree = Awaited<ReturnType<typeof createWorktreeViaDaemon>> & { branch: string };
type TempRepo = Awaited<ReturnType<typeof createTempGitRepo>>;

let client: ArchiveClient;
let repo: TempRepo;
const extraRepos: TempRepo[] = [];
const worktreeDirectories = new Set<string>();

test.describe.configure({ timeout: 120_000 });

test.beforeEach(async () => {
  client = await connectNewWorkspaceDaemonClient();
  repo = await createTempGitRepo("project-archive-");
});

// Closing the owning client removes its projects; managed worktrees on disk are archived first.
test.afterEach(async () => {
  for (const directory of worktreeDirectories) {
    await archiveWorkspaceFromDaemon(client, directory).catch(() => undefined);
  }
  worktreeDirectories.clear();
  await client?.close().catch(() => undefined);
  for (const extra of extraRepos.splice(0)) {
    await extra.cleanup().catch(() => undefined);
  }
  await repo?.cleanup().catch(() => undefined);
});

function readCheckoutBranch(directory: string): string {
  return execFileSync("git", ["branch", "--show-current"], {
    cwd: directory,
    encoding: "utf8",
  }).trim();
}

/** Capture the real saved branch before archive removes the managed checkout. */
async function createRecoveryWorktree(slug: string): Promise<ArchivedWorktree> {
  const workspace = await createWorktreeViaDaemon(client, { cwd: repo.path, slug });
  worktreeDirectories.add(workspace.workspaceDirectory);
  const branch = readCheckoutBranch(workspace.workspaceDirectory);
  expect(branch).not.toBe("");
  return { ...workspace, branch };
}

function sentRestoreRequests(frames: RecoveryFrame[], workspaceId: string) {
  return frames
    .filter((frame) => frame.direction === "sent")
    .map((frame) => frame.message)
    .filter((message) => message.type === "workspace.recovery.restore.request")
    .filter((message) => message.workspaceId === workspaceId);
}

function listRequests(frames: RecoveryFrame[]) {
  return frames
    .map((frame) => frame.message)
    .filter((message) => message.type === "workspace.recovery.list_archived.request");
}

/** Build durable archive records through real daemon actions. */
async function prepareRecoveryFixture() {
  const project = await openProjectViaDaemon(client, repo.path);
  const zeroAgent = await createRecoveryWorktree(`archive-empty-${Date.now()}`);
  const withAgent = await createRecoveryWorktree(`archive-agent-${Date.now()}`);
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
  await expect.poll(() => existsSync(zeroAgent.workspaceDirectory)).toBe(false);
  await expect.poll(() => existsSync(withAgent.workspaceDirectory)).toBe(false);
  const archivedAt = (await client.fetchAgent({ agentId: agent.id }))?.agent.archivedAt;
  expect(archivedAt).toEqual(expect.any(String));
  expect(
    (
      await client.fetchAgentHistory({
        workspaceId: zeroAgent.workspaceId,
        filter: { includeArchived: true },
      })
    ).entries,
  ).toEqual([]);

  // An archived workspace in another project must never appear in this project's chooser.
  const otherRepo = await createTempGitRepo("project-archive-other-");
  extraRepos.push(otherRepo);
  const otherProject = await openProjectViaDaemon(client, otherRepo.path);
  const sentinel = await client.createWorkspace({
    source: { kind: "directory", path: otherRepo.path, projectId: otherProject.projectId },
    title: "Other project archived sentinel",
  });
  expect(sentinel.error).toBeNull();
  expect(sentinel.workspace?.id).toEqual(expect.any(String));
  const sentinelId = sentinel.workspace?.id ?? "";
  await archiveLocalWorkspaceFromDaemon(client, sentinelId);

  return { project, zeroAgent, withAgent, agent, archivedAt, sentinelId };
}

/** Select a row without mutation, then restore through the existing confirmation. */
async function confirmWorktreeRecovery(
  page: Page,
  workspace: ArchivedWorktree,
  frames: RecoveryFrame[],
) {
  expect(sentRestoreRequests(frames, workspace.workspaceId)).toEqual([]);
  await page.getByTestId(`restore-project-workspace-${workspace.workspaceId}`).click();
  await expect(page.getByTestId("restore-project-workspace-dialog")).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/workspace/${workspace.workspaceId}$`));
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
  expect(existsSync(workspace.workspaceDirectory)).toBe(false);
  expect(sentRestoreRequests(frames, workspace.workspaceId)).toEqual([]);

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
  expect(readCheckoutBranch(workspace.workspaceDirectory)).toBe(workspace.branch);
  expect(sentRestoreRequests(frames, workspace.workspaceId)).toHaveLength(1);
}

test("the project archive chooser restores zero-agent worktrees and keeps archived agents archived", async ({
  page,
}) => {
  const wire = recordRecoveryFrames(page);
  try {
    const { project, zeroAgent, withAgent, agent, archivedAt, sentinelId } =
      await prepareRecoveryFixture();
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
    await expect(
      chooser.getByTestId(`restore-project-workspace-${project.workspaceId}`),
    ).toHaveCount(0);
    await expect(chooser.getByTestId(`restore-project-workspace-${sentinelId}`)).toHaveCount(0);
    const initialListCount = listRequests(wire.frames).length;
    expect(listRequests(wire.frames).at(-1)?.projectId).toBe(project.projectId);

    await confirmWorktreeRecovery(page, zeroAgent, wire.frames);
    expect((await client.fetchAgent({ agentId: agent.id }))?.agent.archivedAt).toBe(archivedAt);

    const refreshed = await openArchiveChooser(page, project.projectKey);
    await expect(
      refreshed.getByTestId(`restore-project-workspace-${withAgent.workspaceId}`),
    ).toBeVisible();
    await expect(
      refreshed.getByTestId(`restore-project-workspace-${zeroAgent.workspaceId}`),
    ).toHaveCount(0);
    expect(listRequests(wire.frames).length).toBeGreaterThan(initialListCount);

    await confirmWorktreeRecovery(page, withAgent, wire.frames);
    expect((await client.fetchAgent({ agentId: agent.id }))?.agent.archivedAt).toBe(archivedAt);
    expect((await client.fetchAgents()).entries.map((entry) => entry.agent.id)).not.toContain(
      agent.id,
    );
    expect(
      wire.frames.filter(
        (frame) => frame.direction === "sent" && frame.message.type === "refresh_agent_request",
      ),
    ).toEqual([]);
  } finally {
    wire.stop();
  }
});

/** A project with two ordinary workspaces and one background workspace on this host. */
async function prepareArchiveAllFixture() {
  const project = await openProjectViaDaemon(client, repo.path);
  const source = { kind: "directory" as const, path: repo.path, projectId: project.projectId };
  const second = await client.createWorkspace({ source, title: "Second ordinary workspace" });
  const background = await client.createWorkspace({
    source,
    title: "Background job",
    background: true,
  });
  expect(second.error).toBeNull();
  expect(background.error).toBeNull();
  return {
    project,
    source,
    secondId: second.workspace?.id ?? "",
    backgroundId: background.workspace?.id ?? "",
  };
}

/** Active workspace ids of one project on this host, background work included. */
async function activeProjectWorkspaceIds(projectId: string): Promise<string[]> {
  const listed = await client.fetchWorkspaces({ filter: { projectId, includeBackground: true } });
  return listed.entries.map((entry) => entry.id).sort();
}

async function openProjectInSidebar(page: Page, workspaceIds: string[]) {
  await gotoAppShell(page);
  await waitForSidebarHydration(page);
  for (const workspaceId of workspaceIds) {
    await waitForWorkspaceInSidebar(page, { serverId: getServerId(), workspaceId });
  }
}

test("Archive all archives a project's workspaces, including background work after opt-in", async ({
  page,
}) => {
  const { project, secondId, backgroundId } = await prepareArchiveAllFixture();
  await openProjectInSidebar(page, [project.workspaceId, secondId]);

  const confirmation = await openArchiveAllConfirmation(page, project.projectKey);
  const counts = confirmation.getByTestId("project-archive-counts");
  await expect(counts).toContainText("Workspaces: 2");
  await confirmation.getByTestId("project-archive-include-background").click();
  await expect(counts).toContainText("Workspaces: 3");
  await confirmation.getByTestId("project-archive-confirm").click();

  await expect(page.getByTestId("app-toast-message")).toHaveText("Archived workspaces: 3");
  await expectWorkspaceAbsentFromSidebar(page, project.workspaceId);
  await expectWorkspaceAbsentFromSidebar(page, secondId);
  await expect.poll(() => activeProjectWorkspaceIds(project.projectId)).toEqual([]);
  expect(backgroundId).not.toBe("");
});

test("Archive all stops and leaves every workspace when the project changes during confirmation", async ({
  page,
}) => {
  const { project, source, secondId, backgroundId } = await prepareArchiveAllFixture();
  await openProjectInSidebar(page, [project.workspaceId, secondId]);
  const before = await activeProjectWorkspaceIds(project.projectId);

  const confirmation = await openArchiveAllConfirmation(page, project.projectKey);
  const added = await client.createWorkspace({ source, title: "Added during confirmation" });
  expect(added.error).toBeNull();
  await confirmation.getByTestId("project-archive-confirm").click();

  await expect(page.getByTestId("app-toast-message")).toHaveText(
    "The project changed during confirmation. Review the counts and try Archive all again.",
  );
  await waitForWorkspaceInSidebar(page, {
    serverId: getServerId(),
    workspaceId: project.workspaceId,
  });
  await waitForWorkspaceInSidebar(page, { serverId: getServerId(), workspaceId: secondId });
  expect(await activeProjectWorkspaceIds(project.projectId)).toEqual(
    [...before, added.workspace?.id ?? ""].sort(),
  );
  expect(before).toContain(backgroundId);
});
