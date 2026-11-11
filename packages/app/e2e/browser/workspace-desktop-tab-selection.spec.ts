import { test, expect, type Page } from "../support/fixtures";
import { seedWorkspace } from "../support/helpers/seed-client";
import { createIdleAgent, expectWorkspaceTabVisible } from "../support/helpers/archive-tab";
import { waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import { getServerId } from "../support/helpers/server-id";

async function openAgentInWorkspace(page: Page, agent: { id: string; workspaceId: string }) {
  await page.goto(buildHostAgentDetailRoute(getServerId(), agent.id, agent.workspaceId));
  await page.waitForURL(
    (url) => url.pathname.includes("/workspace/") && !url.searchParams.has("open"),
    { timeout: 60_000 },
  );
  await waitForWorkspaceTabsVisible(page);
  await expectWorkspaceTabVisible(page, agent.id);
}

test.describe("Desktop workspace tab selection", () => {
  test("selects a tab when the click completes, not on mouse down", async ({ page }) => {
    test.setTimeout(120_000);
    const workspace = await seedWorkspace({ repoPrefix: "workspace-desktop-tab-select-" });

    try {
      const first = await createIdleAgent(workspace.client, {
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: "First desktop tab",
      });
      const second = await createIdleAgent(workspace.client, {
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: "Second desktop tab",
      });
      await openAgentInWorkspace(page, first);
      await openAgentInWorkspace(page, second);

      const firstTab = page.getByTestId(`workspace-tab-agent_${first.id}`).first();
      const secondTab = page.getByTestId(`workspace-tab-agent_${second.id}`).first();
      await expect(secondTab).toHaveAttribute("aria-selected", "true");

      const box = await firstTab.boundingBox();
      if (!box) throw new Error("Expected the first tab to be laid out");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      // A press that has not completed must not select, so a drag that starts here can still move it.
      await expect(firstTab).toHaveAttribute("aria-selected", "false");
      await expect(secondTab).toHaveAttribute("aria-selected", "true");

      await page.mouse.up();
      await expect(firstTab).toHaveAttribute("aria-selected", "true");
    } finally {
      await workspace.cleanup();
    }
  });
});
