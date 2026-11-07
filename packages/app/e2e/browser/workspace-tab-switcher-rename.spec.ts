import type { Page, TestInfo } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { test, expect } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { renameModalInput, renameModalSubmit } from "../support/helpers/rename";
import type { SeedDaemonClient } from "../support/helpers/seed-client";
import {
  openSettingsSection,
  openCompactSettings,
  goBackInSettings,
  closeCompactSettings,
} from "../support/helpers/settings";
import {
  mainWorkspaceTabRow,
  chooserTabLabel,
  readWorkspaceTabSnapshot,
  seedLegacyCompactTabSwitcher,
} from "../support/helpers/workspace-tabs";
import { composerLocator } from "../support/helpers/composer";
import { clickSessionRow, expectSessionRowVisible } from "../support/helpers/archive-tab";

const MOBILE_VIEWPORT = { width: 390, height: 844 };

test.use({ viewport: MOBILE_VIEWPORT, deviceScaleFactor: 2 });

async function captureScreen(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ path: testInfo.outputPath(name + ".png") });
}

async function fetchAgentTitle(client: SeedDaemonClient, agentId: string): Promise<string | null> {
  const result = await client.fetchAgents({ scope: "active" });
  return result.entries.find((entry) => entry.agent.id === agentId)?.agent.title ?? null;
}

/** Read stable tab identities across named navigation and persisted layout hydration. */
function readTabIdentities(nodes: Element[]): Array<string | null> {
  return nodes.map((node) => node.getAttribute("data-testid"));
}

/** Set one central feature through its real settings control and restore the workspace route. */
async function setWorkspaceFeature(
  page: Page,
  feature: "mobileWorkspaceTabs" | "previousAgents",
  { enabled }: { enabled: boolean },
) {
  const workspacePath = new URL(page.url()).pathname;
  // Compact layouts intentionally disable desktop shortcuts. Use the real
  // Settings navigation so the retained draft survives without a page reload.
  await openCompactSettings(page, workspacePath);
  await openSettingsSection(page, "paseo-plus-plus");
  const control = page.getByTestId(`paseo-plus-plus-${feature}`).getByRole("switch");
  await expect(control).toBeVisible();
  await expect(control).toBeChecked({ checked: !enabled });
  await control.click();
  await expect(control).toBeChecked({ checked: enabled });
  await expect(control).toBeEnabled();
  await goBackInSettings(page);
  await closeCompactSettings(page);
  await expect(page).toHaveURL(workspacePath);
}

/** Return tab identities without placing a nested array callback inside a polling assertion. */
async function readWorkspaceTabIds(page: Page, workspaceId: string) {
  return (await readWorkspaceTabSnapshot(page, workspaceId)).tabs.map((tab) => tab.tabId);
}

/** Read selection independently of the chooser's count-only trigger. */
async function readFocusedWorkspaceTabId(page: Page, workspaceId: string) {
  return (await readWorkspaceTabSnapshot(page, workspaceId)).focusedTabId;
}

/** Find the persisted tab of the seeded agent, whose ID the chooser's row actions are keyed by. */
async function readAgentTabId(page: Page, session: { workspaceId: string; agentId: string }) {
  const snapshot = await readWorkspaceTabSnapshot(page, session.workspaceId);
  const tab = snapshot.tabs.find(
    (entry) => entry.target.kind === "agent" && entry.target.agentId === session.agentId,
  );
  if (!tab) throw new Error("Expected the seeded agent tab");
  return tab.tabId;
}

/** Open a seeded agent with the legacy tab chooser instead of the compact strip. */
async function openWithLegacyChooser(page: Page, session: Parameters<typeof openAgentRoute>[1]) {
  await seedLegacyCompactTabSwitcher(page);
  await openAgentRoute(page, session);
  const switcher = page.getByTestId("workspace-tab-switcher-trigger");
  await expect(switcher).toBeVisible();
  return switcher;
}

/** Wait for all compact overlays to dismiss before a product example capture. */
async function expectCompactOverlaysClosed(page: Page) {
  await expect(
    page.getByRole("button", { name: "Bottom sheet backdrop" }).filter({ visible: true }),
  ).toHaveCount(0);
}

/** Compact tabs keep visible session actions and present rename in the shared mobile sheet. */
test.describe("Workspace session rename (compact tabs)", () => {
  test("renames an agent session from its tab actions sheet", async ({ page }, testInfo) => {
    test.setTimeout(120_000);

    await page.setViewportSize(MOBILE_VIEWPORT);
    const initialTitle = `switcher-rename-${randomUUID().slice(0, 8)}`;
    const session = await seedMockAgentWorkspace({
      repoPrefix: "workspace-switcher-rename-",
      title: initialTitle,
    });

    try {
      await openAgentRoute(page, session);
      const row = mainWorkspaceTabRow({ page, agentId: session.agentId });
      const tab = row.getByTestId(`workspace-tab-agent_${session.agentId}`);
      await expect(tab).toBeVisible({ timeout: 30_000 });
      await expect(tab).toHaveAttribute("aria-selected", "true");
      await expect(row.getByTestId("workspace-tabs-scroll")).toBeVisible();
      await expect(row.getByTestId("workspace-new-tab-button")).toBeVisible();

      const menuBase = `workspace-tab-menu-agent_${session.agentId}`;
      // Compact tabs use the same long-press/context menu, with no redundant ellipsis.
      await tab.click({ button: "right" });

      const renameItem = page.getByTestId(`${menuBase}-rename`);
      await expect(renameItem).toBeVisible({ timeout: 10_000 });
      await renameItem.click();

      const modalPrefix = `workspace-tab-rename-modal-agent-${session.agentId}`;
      const input = renameModalInput(page, modalPrefix);
      await expect(input).toBeVisible({ timeout: 10_000 });
      await expect(input).toHaveValue(initialTitle);

      const renamed = "Renamed from the tab";
      await input.fill(renamed);
      await renameModalSubmit(page, modalPrefix).click();

      await expect(input).toHaveCount(0, { timeout: 15_000 });
      await expect(tab).toContainText(renamed, {
        timeout: 15_000,
      });
      await expect(row.getByTestId("workspace-tabs-scroll").getByRole("tab")).toHaveCount(1);
      await expect.poll(() => fetchAgentTitle(session.client, session.agentId)).toBe(renamed);
      await expect(page.getByText("Rename agent", { exact: true })).not.toBeVisible();
      await expect(
        page.getByRole("button", { name: "Bottom sheet backdrop" }).filter({ visible: true }),
      ).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath("compact-renamed-tab.png") });
    } finally {
      await session.cleanup();
    }
  });

  test("scrolls readable tabs and reveals new and selected tabs after rotation", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    const session = await seedMockAgentWorkspace({
      repoPrefix: "compact-tab-scroll-",
      title: "First compact workspace tab",
    });
    try {
      await openAgentRoute(page, session);
      const row = mainWorkspaceTabRow({ page, agentId: session.agentId });
      const first = row.getByTestId(`workspace-tab-agent_${session.agentId}`);
      await expect(first).toBeVisible({ timeout: 30_000 });
      const newTabs = row.locator('[data-testid^="workspace-tab-draft_"]');
      for (let index = 0; index < 5; index++) {
        await row.getByTestId("workspace-new-tab-button").click();
        await page.getByTestId("workspace-new-tab-menu-agent").filter({ visible: true }).click();
        await expect(newTabs).toHaveCount(index + 1);
        await expect(newTabs.last()).toHaveAttribute("aria-selected", "true");
        await expect(newTabs.last()).toBeInViewport({ ratio: 1 });
      }
      await expect(first).not.toBeInViewport();
      const latest = newTabs.last();
      const tabBox = await latest.boundingBox();
      const plusBox = await row.getByTestId("workspace-new-tab-button").boundingBox();
      expect(tabBox?.height).toBeGreaterThanOrEqual(44);
      expect(plusBox?.height).toBeGreaterThanOrEqual(44);

      // Compact intentionally disables keyboard shortcuts. Named workspace navigation selects
      // the existing session while preserving all newly opened tabs and their identities.
      const draftIdentities = await newTabs.evaluateAll(readTabIdentities);
      await openAgentRoute(page, session);
      await expect(first).toHaveAttribute("aria-selected", "true");
      await expect(first).toBeInViewport({ ratio: 1 });
      await expect(newTabs).toHaveCount(5);
      expect(await newTabs.evaluateAll(readTabIdentities)).toEqual(draftIdentities);
      await latest.click();
      await expect(latest).toHaveAttribute("aria-selected", "true");
      await expect(latest).toBeInViewport({ ratio: 1 });

      await page.setViewportSize({ width: 540, height: 390 });
      await expect(latest).toHaveAttribute("aria-selected", "true");
      await expect(latest).toBeInViewport({ ratio: 1 });
      await page.setViewportSize(MOBILE_VIEWPORT);
      await expect(latest).toBeInViewport({ ratio: 1 });
      await page.screenshot({ path: testInfo.outputPath("compact-scroll-selected.png") });
      await row.getByTestId("workspace-new-tab-button").click();
      await expect(
        page.getByTestId("workspace-new-tab-menu").filter({ visible: true }),
      ).toBeVisible();
    } finally {
      await session.cleanup();
    }
  });

  test("legacy opt-out preserves the selected tab, tab IDs and draft content", async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize(MOBILE_VIEWPORT);
    const session = await seedMockAgentWorkspace({
      title: "Release checklist",
      repoPrefix: "mobile-tabs-opt-out-",
    });
    try {
      await openAgentRoute(page, session);
      const row = mainWorkspaceTabRow({ page, agentId: session.agentId });
      await row.getByTestId("workspace-new-tab-button").click();
      await page.getByTestId("workspace-new-tab-menu-agent").filter({ visible: true }).click();
      const draftText = "Keep this draft while changing workspace tab navigation";
      await composerLocator(page).fill(draftText);
      const before = await readWorkspaceTabSnapshot(page, session.workspaceId);
      const draftTab = before.tabs.find((tab) => tab.tabId === before.focusedTabId);
      if (!draftTab || draftTab.target.kind !== "draft") {
        throw new Error("Expected the selected draft before changing tab navigation");
      }
      await expectCompactOverlaysClosed(page);
      await page.screenshot({ path: testInfo.outputPath("mobileWorkspaceTabs-on.png") });

      await setWorkspaceFeature(page, "mobileWorkspaceTabs", { enabled: false });
      const switcher = page.getByTestId("workspace-tab-switcher-trigger");
      await expect(switcher).toBeVisible();
      await expect(mainWorkspaceTabRow({ page }).getByTestId("workspace-tabs-scroll")).toHaveCount(
        0,
      );
      await expect(composerLocator(page)).toHaveValue(draftText);
      expect(await readWorkspaceTabSnapshot(page, session.workspaceId)).toEqual(before);
      await expect(switcher).toHaveAccessibleName("Switch tabs (2 open)");
      await page.screenshot({ path: testInfo.outputPath("mobileWorkspaceTabs-off.png") });
      await switcher.click();
      await expect(
        chooserTabLabel(page, `agent_${session.agentId}`, "Release checklist"),
      ).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("mobileWorkspaceTabs-off-chooser.png") });
      await chooserTabLabel(page, `agent_${session.agentId}`, "Release checklist").click();
      await expect(switcher).toHaveAccessibleName("Switch tabs (2 open)");
      await expect
        .poll(() => readFocusedWorkspaceTabId(page, session.workspaceId))
        .toBe(`agent_${session.agentId}`);

      await page.setViewportSize({ width: 1440, height: 900 });
      await expect(switcher).toHaveCount(0);
      await expect(
        row.getByTestId("workspace-tabs-scroll").filter({ visible: true }),
      ).toBeVisible();
      await page.setViewportSize(MOBILE_VIEWPORT);
      await expect(switcher).toHaveAccessibleName("Switch tabs (2 open)");
      await expect
        .poll(() => readFocusedWorkspaceTabId(page, session.workspaceId))
        .toBe(`agent_${session.agentId}`);

      // Restore the original draft selection before comparing presentation-only changes.
      await switcher.click();
      await chooserTabLabel(page, draftTab.tabId, "New Agent").click();
      await expect(composerLocator(page)).toHaveValue(draftText);
      await setWorkspaceFeature(page, "mobileWorkspaceTabs", { enabled: true });
      await expect(row.getByTestId("workspace-tabs-scroll")).toBeVisible();
      await expect(switcher).toHaveCount(0);
      expect(await readWorkspaceTabSnapshot(page, session.workspaceId)).toEqual(before);
      await expect(composerLocator(page)).toHaveValue(draftText);
    } finally {
      await session.cleanup();
    }
  });

  test("renames a tab through the legacy chooser", async ({ page }) => {
    const session = await seedMockAgentWorkspace({
      title: "Release checklist",
      repoPrefix: "mobile-tabs-chooser-rename-",
    });
    try {
      const switcher = await openWithLegacyChooser(page, session);
      const tabId = await readAgentTabId(page, session);
      const menuBase = `workspace-tab-menu-${tabId}`;
      await switcher.click();
      await page.getByTestId(`${menuBase}-trigger`).click();
      await page.getByTestId(`${menuBase}-rename`).click();
      const prefix = `workspace-tab-rename-modal-agent-${session.agentId}`;
      await renameModalInput(page, prefix).fill("Renamed through legacy chooser");
      await renameModalSubmit(page, prefix).click();
      await expect(page.getByText("Rename agent", { exact: true })).not.toBeVisible();
      // The nested rename sheet closes back to the existing chooser.
      await expect(chooserTabLabel(page, tabId, "Renamed through legacy chooser")).toBeVisible();
    } finally {
      await session.cleanup();
    }
  });

  test("closes a tab through the legacy chooser and reopens it from history", async ({ page }) => {
    const session = await seedMockAgentWorkspace({
      title: "Release checklist",
      repoPrefix: "mobile-tabs-chooser-close-",
    });
    try {
      const switcher = await openWithLegacyChooser(page, session);
      const tabId = await readAgentTabId(page, session);
      await page.getByTestId("workspace-header-menu-trigger").click();
      await page.getByTestId("workspace-header-new-agent").click();
      await expect(switcher).toHaveAccessibleName("Switch tabs (2 open)");
      const draftTabId = await readFocusedWorkspaceTabId(page, session.workspaceId);
      if (!draftTabId || draftTabId === tabId) throw new Error("Expected the new draft selected");

      const menuBase = `workspace-tab-menu-${tabId}`;
      await switcher.click();
      await page.getByTestId(`${menuBase}-trigger`).click();
      await page.getByTestId(`${menuBase}-close`).click();
      await expect.poll(() => readWorkspaceTabIds(page, session.workspaceId)).not.toContain(tabId);
      // The full-height chooser has no exposed backdrop. Select the remaining draft instead.
      await chooserTabLabel(page, draftTabId, "New Agent").click();
      await expectCompactOverlaysClosed(page);

      await page.getByTestId("workspace-header-menu-trigger").click();
      await page.getByTestId("workspace-new-tab-menu-reopen-closed-agent").click();
      await expectSessionRowVisible(page, "Release checklist");
      await clickSessionRow(page, "Release checklist");
      await expect(switcher).toHaveAccessibleName("Switch tabs (2 open)");
      await expect.poll(() => readFocusedWorkspaceTabId(page, session.workspaceId)).toBe(tabId);
    } finally {
      await session.cleanup();
    }
  });

  test("keeps New agent in the compact header menu when Previous agents is off", async ({
    page,
  }) => {
    const session = await seedMockAgentWorkspace({
      title: "Release checklist",
      repoPrefix: "mobile-tabs-chooser-history-off-",
    });
    try {
      const switcher = await openWithLegacyChooser(page, session);
      await setWorkspaceFeature(page, "previousAgents", { enabled: false });
      await expect(switcher).toBeVisible();
      await page.getByTestId("workspace-header-menu-trigger").click();
      await expect(page.getByTestId("workspace-new-tab-menu-reopen-closed-agent")).toHaveCount(0);
      await expect(page.getByTestId("workspace-header-new-agent")).toBeVisible();
      await expect(page.getByText("Terminal profiles", { exact: true })).toBeVisible();
      await expect(page.getByTestId("workspace-header-edit-terminal-profiles")).toBeVisible();
    } finally {
      await session.cleanup();
    }
  });
});

test("compact tab bar creates tabs and returns to the existing chat", async ({
  page,
}, testInfo) => {
  const session = await seedMockAgentWorkspace({
    repoPrefix: "compact-header-actions-",
    title: "Existing chat",
  });
  try {
    await openAgentRoute(page, session);
    const row = mainWorkspaceTabRow({ page, agentId: session.agentId });
    const tabs = row.getByTestId("workspace-tabs-scroll").getByRole("tab");
    await expect(tabs).toHaveCount(1);

    await row.getByTestId("workspace-new-tab-button").click();
    await page.getByTestId("workspace-new-tab-menu-terminal").filter({ visible: true }).click();
    await expect(tabs).toHaveCount(2);
    await expect(page.getByTestId("terminal-surface").filter({ visible: true })).toHaveCount(1);
    await captureScreen(page, testInfo, "compact-terminal-header");

    await row.getByTestId("workspace-new-tab-button").click();
    await page.getByTestId("workspace-new-tab-menu-agent").filter({ visible: true }).click();
    await expect(tabs).toHaveCount(3);
    await expect(composerLocator(page)).toBeVisible();
    await captureScreen(page, testInfo, "compact-draft-header");

    const existing = row.getByTestId(`workspace-tab-agent_${session.agentId}`);
    await existing.click();
    await expect(existing).toHaveAttribute("aria-selected", "true");
    await expect(tabs).toHaveCount(3);
    await expect(composerLocator(page)).toBeVisible();
    await captureScreen(page, testInfo, "returned-chat-header");
  } finally {
    await session.cleanup();
  }
});
