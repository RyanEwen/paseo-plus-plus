import { expect, type Locator } from "@playwright/test";
import { test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";

const LONG_PROJECT_NAME = "A long project name that should keep its activity and actions readable";

/** Record the element's left edge on every frame for `durationMs`, to prove it moved smoothly. */
async function sampleLeftEdges(target: Locator, durationMs: number): Promise<number[]> {
  return target.evaluate(
    (element, duration) =>
      new Promise<number[]>((resolve) => {
        const positions: number[] = [];
        const startedAt = performance.now();
        function sample() {
          positions.push(element.getBoundingClientRect().x);
          if (performance.now() - startedAt < duration) requestAnimationFrame(sample);
          else resolve(positions);
        }
        requestAnimationFrame(sample);
      }),
    durationMs,
  );
}

/** The chip's right edge, or null while it is not rendered. */
async function readRightEdge(target: Locator): Promise<number | null> {
  const bounds = await target.boundingBox();
  return bounds ? bounds.x + bounds.width : null;
}

test("a project chip stays on the row rail through reload, renames and pinning", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const workspace = await seedWorkspace({
    repoPrefix: "sidebar-activity-",
    title: "Sidebar activity work",
  });
  const serverId = getServerId();
  const row = page.getByTestId(`sidebar-workspace-row-${serverId}:${workspace.workspaceId}`);
  const projectRow = page.getByTestId(`sidebar-project-row-${workspace.projectKey}`);
  const chip = page.getByTestId(`sidebar-project-status-${workspace.projectKey}`);
  try {
    await workspace.client.renameProject(workspace.projectId, LONG_PROJECT_NAME);
    const agent = await workspace.client.createAgent({
      provider: "mock",
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "Activity agent",
      model: "e2e-fast-stream",
      initialPrompt: "Finish this turn.",
    });
    await workspace.client.waitForFinish(agent.id, 20_000);
    await workspace.client.clearWorkspaceAttention(workspace.workspaceId);
    await gotoAppShell(page);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(chip).toHaveText("Done");

    await page.reload();
    await expect(chip).toHaveText("Done", { timeout: 30_000 });

    await row.hover();
    await page.getByTestId(`sidebar-workspace-kebab-${serverId}:${workspace.workspaceId}`).click();
    await page.getByRole("menuitem", { name: "Mark as unread", exact: true }).click();
    await expect(chip).toHaveText("Ready to review");

    // A long title truncates instead of pushing the chip off the row's trailing rail.
    await page.mouse.move(0, 0);
    const projectBounds = await projectRow.boundingBox();
    if (!projectBounds) throw new Error("Project row has no rendered bounds");
    await expect
      .poll(() => readRightEdge(chip))
      .toBeCloseTo(projectBounds.x + projectBounds.width - 8, 0);
    const longNameChip = await chip.boundingBox();
    if (!longNameChip) throw new Error("Project chip has no rendered bounds");

    // A short title leaves the chip where it was rather than pulling it next to the text.
    await workspace.client.renameProject(workspace.projectId, "Short");
    await expect(projectRow).toContainText("Short");
    await expect.poll(async () => (await chip.boundingBox())?.x).toBeCloseTo(longNameChip.x, 0);

    // The aggregate includes pinned workspaces.
    await workspace.client.setWorkspacePinned(workspace.workspaceId, true);
    await expect(page.getByTestId("sidebar-pinned-section")).toBeVisible();
    await expect(chip).toHaveText("Ready to review");
    await page.screenshot({ path: testInfo.outputPath("sidebar-project-activity.png") });
  } finally {
    await workspace.cleanup();
  }
});

test("a working chip counts every working workspace and slides aside for project actions", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const workspace = await seedWorkspace({
    repoPrefix: "sidebar-working-count-",
    title: "First worker",
  });
  try {
    const created = await workspace.client.createWorkspace({
      source: { kind: "worktree", cwd: workspace.repoPath, worktreeSlug: "second-worker" },
      title: "Second worker",
    });
    expect(created.error).toBeNull();
    if (!created.workspace) throw new Error("Second workspace was not created");
    const second = created.workspace;
    await gotoAppShell(page);
    const chip = page.getByTestId(`sidebar-project-status-${workspace.projectKey}`);
    const projectRow = page.getByTestId(`sidebar-project-row-${workspace.projectKey}`);
    await expect(chip).toHaveText("Done", { timeout: 30_000 });

    const firstAgent = await workspace.client.createAgent({
      provider: "mock",
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "First agent",
      model: "one-minute-stream",
      initialPrompt: "Stay busy",
    });
    await workspace.client.waitForAgentUpsert(
      firstAgent.id,
      (agent) => agent.status === "running",
      15_000,
    );
    await expect(chip).toHaveText("Working");
    const secondAgent = await workspace.client.createAgent({
      provider: "mock",
      cwd: second.workspaceDirectory,
      workspaceId: second.id,
      title: "Second agent",
      model: "one-minute-stream",
      initialPrompt: "Stay busy",
    });
    await workspace.client.waitForAgentUpsert(
      secondAgent.id,
      (agent) => agent.status === "running",
      15_000,
    );
    await expect(chip).toHaveText("2 working");

    // The chip owns the working ring; the leading glyph does not repeat it.
    await expect(
      chip.getByTestId(`sidebar-project-working-spinner-${workspace.projectKey}`),
    ).toBeVisible();
    await expect(projectRow.getByTestId("project-status-indicator-running")).toHaveCount(0);

    // Hover reveals the project actions and the chip slides aside rather than jumping.
    await page.mouse.move(0, 0);
    const restingBounds = await chip.boundingBox();
    if (!restingBounds) throw new Error("Working chip has no rendered bounds");
    const motionSamples = sampleLeftEdges(chip, 600);
    await projectRow.hover();
    await expect
      .poll(async () => (await chip.boundingBox())?.x ?? Infinity)
      .toBeLessThan(restingBounds.x - 20);
    await expect(
      page.getByTestId(`sidebar-project-new-worktree-${workspace.projectKey}`),
    ).toBeVisible();
    const hoveredBounds = await chip.boundingBox();
    if (!hoveredBounds) throw new Error("Hovered working chip has no rendered bounds");
    const positions = await motionSamples;
    expect(positions.some((x) => x < restingBounds.x - 2 && x > hoveredBounds.x + 2)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("sidebar-working-chip-hovered.png") });
    await page.mouse.move(0, 0);
    await expect.poll(async () => (await chip.boundingBox())?.x).toBeCloseTo(restingBounds.x, 0);

    // A pinned working workspace still counts toward its project.
    await workspace.client.setWorkspacePinned(second.id, true);
    await expect(chip).toHaveText("2 working");
  } finally {
    await workspace.cleanup();
  }
});
