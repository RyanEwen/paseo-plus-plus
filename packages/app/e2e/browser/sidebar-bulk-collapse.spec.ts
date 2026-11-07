import { expect } from "@playwright/test";
import { test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import {
  collapseAllSidebarSections,
  expandAllSidebarSections,
  openMobileAgentSidebar,
  selectSidebarProjectGrouping,
  selectSidebarStatusGrouping,
} from "../support/helpers/sidebar";

test("expand all and collapse all cover projects, pinned, status groups and the compact menu", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const workspace = await seedWorkspace({
    repoPrefix: "sidebar-bulk-collapse-",
    title: "Sidebar bulk collapse work",
  });
  const serverId = getServerId();
  const row = page.getByTestId(`sidebar-workspace-row-${serverId}:${workspace.workspaceId}`);
  try {
    await gotoAppShell(page);
    await expect(row).toBeVisible({ timeout: 30_000 });

    // Project mode: the collapse persists across a reload.
    await collapseAllSidebarSections(page);
    await expect(row).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("sidebar-expand-all")).toBeVisible({ timeout: 30_000 });
    await expect(row).toHaveCount(0);
    await expandAllSidebarSections(page);
    await expect(row).toBeVisible();

    // The Pinned section collapses with the rest.
    await workspace.client.setWorkspacePinned(workspace.workspaceId, true);
    await expect(page.getByTestId("sidebar-pinned-section")).toBeVisible();
    await collapseAllSidebarSections(page);
    await expect(row).toHaveCount(0);
    await expandAllSidebarSections(page);
    await expect(row).toBeVisible();
    await workspace.client.setWorkspacePinned(workspace.workspaceId, false);
    await expect(page.getByTestId("sidebar-pinned-section")).toHaveCount(0);

    // Status mode collapses status groups.
    await selectSidebarStatusGrouping(page);
    await expect(row).toBeVisible();
    await collapseAllSidebarSections(page);
    await expect(row).toHaveCount(0);
    await expandAllSidebarSections(page);
    await expect(row).toBeVisible();
    await selectSidebarProjectGrouping(page);

    // Compact layouts offer the actions at the top of the Display menu.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    await openMobileAgentSidebar(page);
    await page.getByTestId("sidebar-display-preferences-menu").click();
    await expect(page.getByTestId("sidebar-collapse-all")).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath("sidebar-bulk-actions-compact-dark.png") });
    await collapseAllSidebarSections(page);
    await expect(row).toHaveCount(0);
    await page.getByTestId("sidebar-display-preferences-menu").click();
    await expandAllSidebarSections(page);
    await expect(row).toBeVisible();
  } finally {
    await workspace.cleanup();
  }
});
