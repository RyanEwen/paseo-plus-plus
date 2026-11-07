import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import {
  expectReconnectingToastGone,
  expectReconnectingToastVisible,
  workspaceDeckEntryLocator,
} from "../support/helpers/workspace-ui";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import { test } from "../support/fixtures";
import { getServerId } from "../support/helpers/server-id";
import { connectSeedClient } from "../support/helpers/seed-client";
import { createTempGitRepo } from "../support/helpers/workspace";
import { buildHostWorkspaceRoute, buildSettingsSectionRoute } from "@/utils/host-routes";
import {
  archiveAgentFromDaemon,
  archiveAgentFromSessions,
  clickSessionRow,
  createIdleAgent,
  createMockIdleAgent,
  closeWorkspaceAgentTab,
  expectArchivedAgentFocused,
  expectSessionRowArchived,
  expectSessionRowVisible,
  expectWorkspaceArchiveOutcome,
  expectWorkspaceTabHidden,
  fetchAgentArchivedAt,
  openSessions,
  openWorkspaceWithAgents,
  primeAdditionalPage,
  resetSeededPageState,
  reloadWorkspace,
} from "../support/helpers/archive-tab";
import {
  countTabsOfKind,
  expectAgentTabActive,
  openNewTabMenuWithShortcut,
} from "../support/helpers/launcher";

/** Open the shared launcher dialog from the active desktop workspace. */
async function openReopenDialog(page: Page): Promise<void> {
  await page.getByTestId("workspace-new-tab-button").filter({ visible: true }).first().click();
  await page.getByTestId("workspace-new-tab-menu-reopen-closed-agent").click();
  await expect(page.getByTestId("reopen-closed-agent-dialog-content")).toBeVisible();
}

/** Known host failure must remain actionable and must not be covered by a progress indicator. */
async function expectReopenFailure(page: Page): Promise<void> {
  await expectReconnectingToastVisible(page);
  await expect(page.getByTestId("reopen-closed-agent-error")).toBeVisible();
  await expect(page.getByTestId("reopen-closed-agent-loading")).toHaveCount(0);
  await expect(
    page
      .getByTestId("reopen-closed-agent-error")
      .getByRole("button", { name: "Retry", exact: true }),
  ).toBeVisible();
}

/** Wait for the dialog to observe the recovered host and enable history fetching. */
async function restoreReopenHost(
  page: Page,
  gate: Awaited<ReturnType<typeof installDaemonWebSocketGate>>,
): Promise<void> {
  gate.restore();
  await expect(page.getByTestId("reopen-closed-agent-search")).toBeVisible({ timeout: 30_000 });
  await expectReconnectingToastGone(page);
}

test.describe("Archive tab reconciliation", () => {
  let client: Awaited<ReturnType<typeof connectSeedClient>>;
  let tempRepo: { path: string; cleanup: () => Promise<void> };
  let projectId: string;
  let workspaceId: string;

  test.describe.configure({ timeout: 300_000 });

  test.beforeAll(async () => {
    tempRepo = await createTempGitRepo("archive-tab-");
    client = await connectSeedClient();
    const created = await client.createWorkspace({
      source: { kind: "directory", path: tempRepo.path },
    });
    if (!created.workspace) {
      throw new Error(created.error ?? `Failed to create workspace ${tempRepo.path}`);
    }
    projectId = created.workspace.projectId;
    workspaceId = created.workspace.id;
  });

  test.afterAll(async () => {
    await client?.removeProject(projectId).catch(() => undefined);
    await client?.close().catch(() => undefined);
    await tempRepo?.cleanup();
  });

  /** Seed one archived agent and one open agent in the shared workspace at the given width. */
  async function seedArchivedAgent(page: Page, width: number) {
    const archived = await createMockIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId,
      title: `previous-archived-${randomUUID().slice(0, 8)}`,
    });
    const surviving = await createMockIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId,
      title: `previous-open-${randomUUID().slice(0, 8)}`,
    });
    await resetSeededPageState(page);
    await openWorkspaceWithAgents(page, [archived, surviving]);
    await archiveAgentFromDaemon(client, archived.id);
    await expectWorkspaceTabHidden(page, archived.id);
    await page.setViewportSize({ width, height: 900 });
    return { archived, surviving };
  }

  /** The dialog is open over the workspace and the menu that opened it has closed. */
  async function expectDialogReplacedMenu(page: Page, menuTestId: string): Promise<void> {
    await expect(page.getByTestId(menuTestId).filter({ visible: true })).toHaveCount(0);
    await expect(
      page.getByText("Reopen closed agent", { exact: true }).filter({ visible: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByTestId("reopen-closed-agent-dialog").filter({ visible: true }).first(),
    ).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/workspace/${workspaceId}`));
  }

  /**
   * The dialog lists only the archived agent, opens it without unarchiving, and leaves
   * Unarchive as the explicit step that resumes it.
   */
  async function expectArchivedAgentReopens(
    page: Page,
    agents: { archived: { id: string; title: string }; surviving: { title: string } },
    screenshotPath: string,
  ): Promise<void> {
    const { archived, surviving } = agents;
    const content = page.getByTestId("reopen-closed-agent-dialog-content");
    await expect(content).toBeVisible();
    await expectSessionRowArchived(page, archived.title);
    const dialogTitle = content.getByTestId(`agent-row-title-${getServerId()}-${archived.id}`);
    const titleFits = await dialogTitle.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    );
    expect(titleFits).toBe(true);
    await page.screenshot({ path: screenshotPath });
    await expect(content.getByRole("button").filter({ hasText: surviving.title })).toHaveCount(0);
    await clickSessionRow(page, archived.title);
    await expect(content).toHaveCount(0);
    await expect(
      page.getByText("This agent is archived").filter({ visible: true }).first(),
    ).toBeVisible();
    expect(await fetchAgentArchivedAt(client, archived.id)).not.toBeNull();
    await page.getByRole("button", { name: "Unarchive", exact: true }).click();
    await expect.poll(() => fetchAgentArchivedAt(client, archived.id)).toBeNull();
    await expect(page.getByText("This agent is archived").filter({ visible: true })).toHaveCount(0);
  }

  test("Reopen closed agent opens archived history from the compact workspace menu", async ({
    page,
  }, testInfo) => {
    const agents = await seedArchivedAgent(page, 390);
    await page
      .getByTestId("workspace-header-menu-trigger")
      .filter({ visible: true })
      .first()
      .click();
    await page.getByTestId("workspace-new-tab-menu-reopen-closed-agent").click();

    await expectDialogReplacedMenu(page, "workspace-header-menu");
    await expect(
      page.getByText("Workspace actions", { exact: true }).filter({ visible: true }),
    ).toHaveCount(0);
    await expectArchivedAgentReopens(page, agents, testInfo.outputPath("previous-agents.png"));
  });

  test("Reopen closed agent opens archived history from the desktop + menu", async ({
    page,
  }, testInfo) => {
    const agents = await seedArchivedAgent(page, 1440);
    const trigger = page.getByTestId("workspace-new-tab-button").filter({ visible: true }).first();
    const menuItem = page.getByTestId("workspace-new-tab-menu-reopen-closed-agent");
    await trigger.focus();
    await trigger.press("Enter");
    await menuItem.press("Enter");
    await expectDialogReplacedMenu(page, "workspace-new-tab-menu");

    // Escape dismisses the dialog, and the keyboard reopens it from the same menu.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("reopen-closed-agent-dialog-content")).toHaveCount(0);
    await trigger.press("Enter");
    await menuItem.press("Enter");

    await expectArchivedAgentReopens(page, agents, testInfo.outputPath("previous-agents.png"));
  });

  test("Reopen closed agent leaves the + menu while its setting is off", async ({ page }) => {
    // resetSeededPageState clears device settings, so the next test starts with the default (on).
    await resetSeededPageState(page);
    await page.goto(buildSettingsSectionRoute("paseo-plus-plus"));
    const toggle = page.getByTestId("paseo-plus-plus-previousAgents").getByRole("switch");
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();

    await page.goto(buildHostWorkspaceRoute(getServerId(), workspaceId));
    await page.getByTestId("workspace-new-tab-button").filter({ visible: true }).first().click();
    await expect(
      page.getByTestId("workspace-new-tab-menu").filter({ visible: true }),
    ).toBeVisible();
    await expect(page.getByTestId("workspace-new-tab-menu-reopen-closed-agent")).toHaveCount(0);
  });

  test("Reopen closed agent from an empty pane replaces the launcher tab with the agent", async ({
    page,
  }) => {
    const closed = await createMockIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId,
      title: `previous-closed-${randomUUID().slice(0, 8)}`,
    });
    const open = await createMockIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId,
      title: `previous-kept-${randomUUID().slice(0, 8)}`,
    });
    await resetSeededPageState(page);
    await openWorkspaceWithAgents(page, [closed, open]);
    await closeWorkspaceAgentTab(page, closed.id);

    await openNewTabMenuWithShortcut(page);
    const launcherTabs = await countTabsOfKind(page, "new_tab");
    expect(launcherTabs).toBeGreaterThan(0);
    await page
      .getByTestId("workspace-new-tab-panel")
      .filter({ visible: true })
      .getByTestId("workspace-new-tab-reopen-closed-agent")
      .click();
    await clickSessionRow(page, closed.title);

    await expect(page.getByTestId("reopen-closed-agent-dialog-content")).toHaveCount(0);
    await expectAgentTabActive(page, closed.id);
    await expect.poll(() => countTabsOfKind(page, "new_tab")).toBe(launcherTabs - 1);
  });

  test("Reopen closed agent opens a hidden live subagent without creating or archiving a session", async ({
    page,
  }) => {
    const parent = await createMockIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId,
      title: "Previous agents parent",
    });
    const title = `previous-subagent-${randomUUID().slice(0, 8)}`;
    const child = await client.createAgent({
      provider: "mock",
      model: "e2e-fast-stream",
      modeId: "load-test",
      cwd: tempRepo.path,
      workspaceId,
      title,
      labels: { "paseo.parent-agent-id": parent.id },
    });
    await client.waitForAgentUpsert(child.id, (agent) => agent.status === "idle");
    await resetSeededPageState(page);
    await openWorkspaceWithAgents(page, [
      parent,
      { id: child.id, title, cwd: tempRepo.path, workspaceId },
    ]);
    await closeWorkspaceAgentTab(page, child.id);
    expect(await fetchAgentArchivedAt(client, child.id)).toBeNull();
    await page.getByTestId("workspace-new-tab-button").filter({ visible: true }).first().click();
    await page.getByTestId("workspace-new-tab-menu-reopen-closed-agent").click();
    await expectSessionRowVisible(page, title);
    await clickSessionRow(page, title);
    await expectAgentTabActive(page, child.id);
    expect(await fetchAgentArchivedAt(client, child.id)).toBeNull();
  });

  test("Reopen closed agent reports held-initial failure, then recovers cached rows", async ({
    page,
  }) => {
    const archived = await createMockIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId,
      title: `repair-initial-${randomUUID().slice(0, 8)}`,
    });
    const active = await createMockIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId,
      title: "Repair active",
    });
    const gate = await installDaemonWebSocketGate(page);
    await resetSeededPageState(page);
    await openWorkspaceWithAgents(page, [archived, active]);
    await archiveAgentFromDaemon(client, archived.id);
    await expectWorkspaceTabHidden(page, archived.id);
    gate.holdNextClientRequest("fetch_agent_history_request");
    await openReopenDialog(page);
    await gate.waitForHeldClientRequest();
    await expect(page.getByTestId("reopen-closed-agent-loading")).toBeVisible();
    await gate.drop();
    await expectReopenFailure(page);
    await page.keyboard.press("Escape");
    await openReopenDialog(page);
    await expectReopenFailure(page);
    gate.discardHeldClientRequest();
    await restoreReopenHost(page, gate);
    await expectSessionRowArchived(page, archived.title);
    await expect(page.getByTestId("reopen-closed-agent-error")).toHaveCount(0);
    await gate.drop();
    await expectReopenFailure(page);
    await expectSessionRowArchived(page, archived.title);
    await restoreReopenHost(page, gate);
    await expect(page.getByTestId("reopen-closed-agent-error")).toHaveCount(0);
    await expectSessionRowArchived(page, archived.title);
  });

  test("Reopen closed agent reports fresh-offline failure without starting a fetch", async ({
    page,
  }) => {
    const archived = await createMockIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId,
      title: `repair-offline-${randomUUID().slice(0, 8)}`,
    });
    const active = await createMockIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId,
      title: "Offline repair active",
    });
    const gate = await installDaemonWebSocketGate(page);
    await resetSeededPageState(page);
    await openWorkspaceWithAgents(page, [archived, active]);
    await archiveAgentFromDaemon(client, archived.id);
    await expectWorkspaceTabHidden(page, archived.id);
    // Route/tab readiness alone can leave the active pane loading when the host is dropped.
    await expectAgentTabActive(page, active.id);
    const activePane = workspaceDeckEntryLocator(page, getServerId(), workspaceId).getByTestId(
      "workspace-pane-main",
    );
    const composer = activePane
      .getByRole("textbox", { name: "Message agent...", exact: true })
      .filter({ visible: true });
    await expect(composer).toHaveCount(1);
    await expect(composer).toBeEditable({ timeout: 15_000 });
    await gate.drop();
    await openReopenDialog(page);
    await expectReopenFailure(page);
    expect(gate.getClientRequestCount("fetch_agent_history_request")).toBe(0);
    await restoreReopenHost(page, gate);
    await expectSessionRowArchived(page, archived.title);
    await expect(page.getByTestId("reopen-closed-agent-error")).toHaveCount(0);
  });

  test("Reopen closed agent stops cached all-open pagination on disconnect and resumes in the same workspace", async ({
    page,
  }) => {
    const created = await client.createWorkspace({
      source: { kind: "directory", path: tempRepo.path },
      title: "Pagination repair",
    });
    if (!created.workspace)
      throw new Error(created.error ?? "Missing pagination fixture workspace");
    const scopedWorkspaceId = created.workspace.id;
    const archived = await createMockIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId: scopedWorkspaceId,
      title: `repair-page-closed-${randomUUID().slice(0, 8)}`,
    });
    await archiveAgentFromDaemon(client, archived.id);
    const activeAgents = [];
    for (let index = 0; index < 200; index += 1) {
      activeAgents.push(
        await createMockIdleAgent(client, {
          cwd: tempRepo.path,
          workspaceId: scopedWorkspaceId,
          title: `repair-open-${index}`,
        }),
      );
    }
    const gate = await installDaemonWebSocketGate(page);
    await resetSeededPageState(page);
    await openWorkspaceWithAgents(page, [activeAgents[0], activeAgents[199]]);
    gate.holdNextServerMessage("fetch_agent_history_response");
    await openReopenDialog(page);
    await gate.waitForHeldServerMessage("fetch_agent_history_response");
    gate.holdNextClientRequest("fetch_agent_history_request");
    gate.releaseHeldServerMessage("fetch_agent_history_response");
    await gate.waitForHeldClientRequest();
    await expect(page.getByTestId("reopen-closed-agent-loading")).toBeVisible();
    await gate.drop();
    await expectReopenFailure(page);
    await page.keyboard.press("Escape");
    await openReopenDialog(page);
    await expectReopenFailure(page);
    await expect(page).toHaveURL(new RegExp(`/workspace/${scopedWorkspaceId}`));
    gate.discardHeldClientRequest();
    await restoreReopenHost(page, gate);
    await expectSessionRowArchived(page, archived.title);
    await expect(page.getByTestId("reopen-closed-agent-error")).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/workspace/${scopedWorkspaceId}`));
  });

  test("non-UI archive prunes the archived tab across open pages and reload", async ({ page }) => {
    const archived = await createIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId,
      title: `cli-archive-${randomUUID().slice(0, 8)}`,
    });
    const surviving = await createIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId,
      title: `cli-control-${randomUUID().slice(0, 8)}`,
    });
    const passivePage = await page.context().newPage();

    try {
      await primeAdditionalPage(passivePage);
      await resetSeededPageState(page);
      await resetSeededPageState(passivePage);
      await openSessions(page);
      await expectSessionRowVisible(page, archived.title);
      await expectSessionRowVisible(page, surviving.title);
      await openSessions(passivePage);
      await expectSessionRowVisible(passivePage, archived.title);
      await expectSessionRowVisible(passivePage, surviving.title);
      await openWorkspaceWithAgents(page, [archived, surviving]);
      await openWorkspaceWithAgents(passivePage, [archived, surviving]);
      await archiveAgentFromDaemon(client, archived.id);
      await expectWorkspaceArchiveOutcome(page, {
        archivedAgentId: archived.id,
        survivingAgentId: surviving.id,
      });
      await expectWorkspaceArchiveOutcome(passivePage, {
        archivedAgentId: archived.id,
        survivingAgentId: surviving.id,
      });
      await reloadWorkspace(passivePage, surviving.workspaceId);
      await expectWorkspaceTabHidden(passivePage, archived.id);
    } finally {
      await passivePage.close();
    }
  });

  test("Sessions archive prunes the archived tab across open pages", async ({ page }) => {
    const archived = await createIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId,
      title: `ui-archive-${randomUUID().slice(0, 8)}`,
    });
    const surviving = await createIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId,
      title: `ui-control-${randomUUID().slice(0, 8)}`,
    });
    const passivePage = await page.context().newPage();

    try {
      await primeAdditionalPage(passivePage);
      await resetSeededPageState(page);
      await resetSeededPageState(passivePage);
      await openWorkspaceWithAgents(page, [archived, surviving]);
      await openWorkspaceWithAgents(passivePage, [archived, surviving]);
      await openSessions(page);
      await archiveAgentFromSessions(page, { agentId: archived.id, title: archived.title });
      await reloadWorkspace(page, surviving.workspaceId);
      await expectWorkspaceTabHidden(page, archived.id);
      await expectWorkspaceArchiveOutcome(passivePage, {
        archivedAgentId: archived.id,
        survivingAgentId: surviving.id,
      });
    } finally {
      await passivePage.close();
    }
  });

  test("clicking an archived session navigates without unarchiving it", async ({ page }) => {
    const archived = await createIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId,
      title: `unarchive-archived-${randomUUID().slice(0, 8)}`,
    });
    const surviving = await createIdleAgent(client, {
      cwd: tempRepo.path,
      workspaceId,
      title: `unarchive-control-${randomUUID().slice(0, 8)}`,
    });

    await resetSeededPageState(page);
    await openWorkspaceWithAgents(page, [archived, surviving]);
    await archiveAgentFromDaemon(client, archived.id);
    const archivedAt = await fetchAgentArchivedAt(client, archived.id);
    expect(archivedAt).not.toBeNull();
    await openSessions(page);
    await expectSessionRowArchived(page, archived.title);

    await clickSessionRow(page, archived.title);

    await expectArchivedAgentFocused(page, archived.id);
    await expectAgentTabActive(page, archived.id);
    expect(await fetchAgentArchivedAt(client, archived.id)).toBe(archivedAt);

    await expect(page).toHaveURL(buildHostWorkspaceRoute(getServerId(), archived.workspaceId), {
      timeout: 30_000,
    });
  });
});
