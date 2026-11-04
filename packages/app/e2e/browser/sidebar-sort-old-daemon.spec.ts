import type { Page } from "@playwright/test";
import { buildHostWorkspaceRoute } from "../../src/utils/host-routes";
import { randomUUID } from "node:crypto";
import { metroTest as test, expect } from "../support/fixtures";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import { seedWorkspace } from "../support/helpers/seed-client";
import { buildSeededHost } from "../support/helpers/daemon-registry";
import {
  selectSidebarStatusGrouping,
  sidebarWorkspaceSortMenuItem,
} from "../support/helpers/sidebar";

test("published old daemon keeps workspace navigation and gates sorting", async ({ page }) => {
  test.setTimeout(180_000);
  const daemon = await startIsolatedHostDaemon(`srv_sort_old_${randomUUID()}`, {
    publishedVersion: "0.8.0",
  });
  try {
    const project = await seedWorkspace({ repoPrefix: "sidebar-old-host-", port: daemon.port });
    try {
      const second = await project.client.createWorkspace({
        source: { kind: "directory", path: project.repoPath, projectId: project.projectId },
        title: "Second old workspace",
      });
      expect(second.workspace).toBeTruthy();
      await openPublishedHost(page, daemon, project.workspaceId);
      await openWorkspace(page, daemon.serverId, second.workspace!.id);
      await expectSortingRequiresHostUpdate(page);
      await selectSidebarStatusGrouping(page);
      await expectStatusHasNoSorting(page);
    } finally {
      await project.cleanup();
    }
  } finally {
    await daemon.close();
  }
});

async function openPublishedHost(
  page: Page,
  daemon: { serverId: string; port: number },
  workspaceId: string,
) {
  const host = buildSeededHost({
    serverId: daemon.serverId,
    endpoint: `127.0.0.1:${daemon.port}`,
    nowIso: new Date().toISOString(),
  });
  await page.addInitScript((seededHost) => {
    localStorage.setItem("@paseo:e2e", "1");
    localStorage.setItem("@paseo:daemon-registry", JSON.stringify([seededHost]));
    localStorage.setItem(
      "sidebar-view",
      JSON.stringify({ version: 8, state: { groupMode: "project", workspaceSort: "lastPrompt" } }),
    );
  }, host);
  await page.goto(buildHostWorkspaceRoute(daemon.serverId, workspaceId));
}

async function openWorkspace(page: Page, serverId: string, workspaceId: string) {
  const row = page.getByTestId(`sidebar-workspace-row-${serverId}:${workspaceId}`);
  await expect(row).toBeVisible();
  await row.click();
  await expect(page).toHaveURL(new RegExp(workspaceId));
}

/** Click the single owned Display trigger for the current grouping without a bare-label fallback. */
async function openDisplayPreferences(page: Page, grouping: "Project" | "Status") {
  const trigger = page.getByTestId("sidebar-display-preferences-menu");
  await expect(trigger).toHaveCount(1);
  await expect(trigger).toHaveAttribute("aria-label", `${grouping}: Display preferences`);
  await trigger.click();
}

async function expectSortingRequiresHostUpdate(page: Page) {
  await openDisplayPreferences(page, "Project");
  const sort = sidebarWorkspaceSortMenuItem(page);
  await expect(sort).toHaveCount(1);
  await sort.click();
  await expect(
    page.getByRole("menuitem", { name: "Update hosts to sort workspaces" }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Update hosts to sort workspaces" }),
  ).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: "Created", exact: true })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Last prompt", exact: true })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Manual", exact: true }).click();
  await openDisplayPreferences(page, "Project");
  await expect(sort).toHaveCount(1);
  await expect(sort).toContainText("Manual");
  await page.keyboard.press("Escape");
}

async function expectStatusHasNoSorting(page: Page) {
  await openDisplayPreferences(page, "Status");
  await expect(page.getByRole("menuitem", { name: "Update hosts to sort workspaces" })).toHaveCount(
    0,
  );
  await expect(sidebarWorkspaceSortMenuItem(page)).toHaveCount(0);
}
