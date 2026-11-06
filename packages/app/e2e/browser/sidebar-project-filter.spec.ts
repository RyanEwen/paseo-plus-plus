import { expect, type Locator } from "@playwright/test";
import { test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";
import {
  closeSidebarDisplayPreferences,
  openSidebarProjectFilter,
  pinWorkspaceFromSidebar,
  openMobileAgentSidebar,
  expectMobileAgentSidebarVisible,
  selectAllProjectsFilter,
  selectSidebarStatusGrouping,
  selectSidebarProjectGrouping,
  toggleProjectFilter,
} from "../support/helpers/sidebar";

/** Read the actual scroll owner so a stationary list cannot satisfy the geometry case. */
async function readScrollTop(scroll: Locator): Promise<number> {
  return scroll.evaluate((element) => element.scrollTop);
}

/** Every activity state uses the trailing rail rather than the leading title rail. */
async function expectStatusOnRight(row: Locator, state: string): Promise<void> {
  const rowBounds = await row.boundingBox();
  const statusBounds = await row.getByTestId(`workspace-status-indicator-${state}`).boundingBox();
  if (!rowBounds || !statusBounds) throw new Error("Workspace status has no rendered bounds");
  expect(statusBounds.x).toBeGreaterThan(rowBounds.x + rowBounds.width / 2);
}

test.describe("Sidebar project filter", () => {
  test.describe.configure({ timeout: 180_000 });

  test("pins the sidebar to one project across both grouping modes", async ({ page }) => {
    // Two temp repos means two projects, which is also what makes the `Project ›` row appear.
    const alpha = await seedWorkspace({ repoPrefix: "project-filter-alpha-", title: "Alpha work" });
    const beta = await seedWorkspace({ repoPrefix: "project-filter-beta-", title: "Beta work" });
    const serverId = getServerId();
    const alphaRow = page.getByTestId(`sidebar-workspace-row-${serverId}:${alpha.workspaceId}`);
    const betaRow = page.getByTestId(`sidebar-workspace-row-${serverId}:${beta.workspaceId}`);
    const filterTrigger = page.getByTestId("sidebar-display-project-filter");

    try {
      await gotoAppShell(page);
      await expect(alphaRow).toBeVisible({ timeout: 30_000 });
      await expect(betaRow).toBeVisible({ timeout: 30_000 });

      await page.getByTestId("sidebar-display-preferences-menu").click();
      await expect(page.getByRole("menuitem")).toHaveText([
        /^Grouping/,
        /^Sort/,
        /^Title/,
        "Show",
        "Project",
        "Show background",
      ]);
      await closeSidebarDisplayPreferences(page);

      await openSidebarProjectFilter(page);
      await expect(page.getByTestId("sidebar-project-filter-all")).toBeVisible();
      await toggleProjectFilter(page, alpha.projectKey);
      await closeSidebarDisplayPreferences(page);

      await expect(alphaRow).toBeVisible();
      await expect(betaRow).toHaveCount(0, { timeout: 10_000 });

      // The indicator reads the filter as it is applied, so it must be on here.
      await page.getByTestId("sidebar-display-preferences-menu").click();
      await expect(filterTrigger).toBeVisible();
      await expect(filterTrigger.getByTestId("menu-sub-indicator")).toBeVisible();
      await closeSidebarDisplayPreferences(page);

      // Status grouping builds its rows from the workspace entries rather than the projects
      // array, so a filter applied in only one of the two places passes every check above and
      // silently fails right here.
      await selectSidebarStatusGrouping(page);
      await closeSidebarDisplayPreferences(page);
      await expect(alphaRow).toBeVisible({ timeout: 15_000 });
      await expect(betaRow).toHaveCount(0);

      // The filter is view state and survives a cold load.
      await page.reload();
      await expect(alphaRow).toBeVisible({ timeout: 30_000 });
      await expect(betaRow).toHaveCount(0);

      await openSidebarProjectFilter(page);
      await selectAllProjectsFilter(page);
      await closeSidebarDisplayPreferences(page);
      await expect(alphaRow).toBeVisible();
      await expect(betaRow).toBeVisible({ timeout: 15_000 });
    } finally {
      await beta.cleanup();
      await alpha.cleanup();
    }
  });

  test("keeps the display menu reachable when the pinned section swallows the filtered project", async ({
    page,
  }) => {
    // Pinning hoists a chat out of its project, and a project whose chats are ALL hoisted is
    // dropped from the project list entirely. Filter to that project and the list body has no
    // project rows left — so the header, which carries the only route back to the filter page,
    // has to survive on the strength of the filter alone.
    const alpha = await seedWorkspace({
      repoPrefix: "project-filter-pinned-",
      title: "Pinned work",
    });
    const beta = await seedWorkspace({ repoPrefix: "project-filter-other-", title: "Other work" });
    const serverId = getServerId();
    const alphaRow = page.getByTestId(`sidebar-workspace-row-${serverId}:${alpha.workspaceId}`);

    try {
      await gotoAppShell(page);
      await expect(alphaRow).toBeVisible({ timeout: 30_000 });

      await openSidebarProjectFilter(page);
      await toggleProjectFilter(page, alpha.projectKey);
      await closeSidebarDisplayPreferences(page);

      await pinWorkspaceFromSidebar(page, alpha.workspaceId);
      await expect(alphaRow).toBeVisible();

      // The way out of the filter is still on screen.
      await expect(page.getByTestId("sidebar-display-preferences-menu")).toBeVisible();
      await openSidebarProjectFilter(page);
      await selectAllProjectsFilter(page);
      await closeSidebarDisplayPreferences(page);
      await expect(
        page.getByTestId(`sidebar-workspace-row-${serverId}:${beta.workspaceId}`),
      ).toBeVisible({ timeout: 15_000 });
    } finally {
      await beta.cleanup();
      await alpha.cleanup();
    }
  });

  test("hides the filter row when there is only one project", async ({ page }) => {
    const only = await seedWorkspace({ repoPrefix: "project-filter-solo-", title: "Solo work" });
    const serverId = getServerId();

    try {
      await gotoAppShell(page);
      await expect(
        page.getByTestId(`sidebar-workspace-row-${serverId}:${only.workspaceId}`),
      ).toBeVisible({ timeout: 30_000 });

      await page.getByTestId("sidebar-display-preferences-menu").click();
      await expect(page.getByTestId("sidebar-display-preferences-content")).toBeVisible();
      await expect(page.getByTestId("sidebar-display-project-filter")).toHaveCount(0);
    } finally {
      await only.cleanup();
    }
  });
});

test("project chips stay visible through bulk collapse and reload", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const workspace = await seedWorkspace({
    repoPrefix: "sidebar-activity-",
    title: "Sidebar activity work",
  });
  const serverId = getServerId();
  const row = page.getByTestId(`sidebar-workspace-row-${serverId}:${workspace.workspaceId}`);
  const chip = page.getByTestId(`sidebar-project-status-${workspace.projectKey}`);
  try {
    await workspace.client.renameProject(
      workspace.projectId,
      "A long project name that should keep its activity and actions readable",
    );
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
    await expectStatusOnRight(row, "done");
    const projectRow = page.getByTestId(`sidebar-project-row-${workspace.projectKey}`);
    await row.hover();
    const workspaceHoverColor = await row.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    await page.mouse.move(0, 0);
    await expect(projectRow).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await projectRow.hover();
    await expect(projectRow).toHaveCSS("background-color", workspaceHoverColor);
    await page.screenshot({ path: testInfo.outputPath("sidebar-project-hover.png") });
    await page.mouse.move(0, 0);

    await page.getByTestId("sidebar-collapse-all").click();
    await expect(row).toHaveCount(0);
    await expect(chip).toHaveText("Done");
    await page.reload();
    await expect(chip).toBeVisible({ timeout: 30_000 });
    await expect(row).toHaveCount(0);
    await page.getByTestId("sidebar-expand-all").click();
    await expect(row).toBeVisible();
    await expect(chip).toHaveText("Done");
    await row.hover();
    await page.getByTestId(`sidebar-workspace-kebab-${serverId}:${workspace.workspaceId}`).click();
    await page.getByRole("menuitem", { name: "Mark as unread", exact: true }).click();
    await expect(chip).toHaveText("Ready to review");
    await expectStatusOnRight(row, "attention");
    await page.mouse.move(0, 0);
    const projectBounds = await projectRow.boundingBox();
    if (!projectBounds) throw new Error("Project row has no rendered bounds");
    await expect
      .poll(async () => {
        const bounds = await chip.boundingBox();
        return bounds ? bounds.x + bounds.width : null;
      })
      .toBeCloseTo(projectBounds.x + projectBounds.width - 8, 0);
    const longNameChip = await chip.boundingBox();
    if (!longNameChip) throw new Error("Project chip has no rendered bounds");
    await workspace.client.renameProject(workspace.projectId, "Short");
    await expect(projectRow).toContainText("Short");
    await expect.poll(async () => (await chip.boundingBox())?.x).toBeCloseTo(longNameChip.x, 0);
    await workspace.client.renameProject(
      workspace.projectId,
      "A long project name that should keep its activity and actions readable",
    );
    await expect(projectRow).toContainText("A long project name");

    await workspace.client.setWorkspacePinned(workspace.workspaceId, true);
    await expect(page.getByTestId("sidebar-pinned-section")).toBeVisible();
    await expect(chip).toHaveText("Ready to review");
    await page.getByTestId("sidebar-collapse-all").click();
    await expect(row).toHaveCount(0);
    await expect(chip).toHaveText("Ready to review");
    await page.getByTestId("sidebar-expand-all").click();
    await expect(row).toBeVisible();
    await workspace.client.setWorkspacePinned(workspace.workspaceId, false);
    await expect(page.getByTestId("sidebar-pinned-section")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("sidebar-project-activity.png") });
    await selectSidebarStatusGrouping(page);
    await expect(row).toBeVisible();
    await page.getByTestId("sidebar-collapse-all").click();
    await expect(row).toHaveCount(0);
    await page.getByTestId("sidebar-expand-all").click();
    await expect(row).toBeVisible();
    await selectSidebarProjectGrouping(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    await openMobileAgentSidebar(page);
    await expectMobileAgentSidebarVisible(page);
    await expect(chip).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("sidebar-project-activity-compact-dark.png"),
    });
    await page.getByTestId("sidebar-display-preferences-menu").click();
    await expect(page.getByTestId("sidebar-collapse-all")).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath("sidebar-bulk-actions-compact-dark.png") });
    await page.getByTestId("sidebar-collapse-all").click();
    await expect(row).toHaveCount(0);
    await expect(chip).toHaveText("Ready to review");
    await page.getByTestId("sidebar-display-preferences-menu").click();
    await page.getByTestId("sidebar-expand-all").click();
    await expect(row).toBeVisible();
  } finally {
    await workspace.cleanup();
  }
});

test("single-project expansion keeps a smaller clicked project visible throughout the collapse animation", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 450 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const projects: Awaited<ReturnType<typeof seedWorkspace>>[] = [];
  try {
    // Collapsed groups below the target keep this a genuinely scrollable sidebar after the switch.
    for (let index = 0; index < 12; index++) {
      const seed = await seedWorkspace({
        repoPrefix: "accordion-anchor-",
        title: `Anchor workspace ${index}`,
        git: false,
      });
      projects.push(seed);
      await seed.client.renameProject(seed.projectId, `Anchor ${String(index).padStart(2, "0")}`);
    }
    const [large, small] = projects;
    for (let index = 1; index < 16; index++) {
      const created = await large.client.createWorkspace({
        source: { kind: "directory", path: large.repoPath, projectId: large.projectId },
        title: `Large workspace ${index}`,
      });
      expect(created.workspace).not.toBeNull();
    }
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await selectSidebarProjectGrouping(page);
    await page.getByTestId("sidebar-collapse-all").click();
    await page.getByTestId("sidebar-display-preferences-menu").click();
    await page.getByTestId("sidebar-one-project-at-a-time").click();
    await closeSidebarDisplayPreferences(page);
    const largeHeader = page.getByTestId(`sidebar-project-row-${large.projectKey}`);
    const smallHeader = page.getByTestId(`sidebar-project-row-${small.projectKey}`);
    const scroll = page.getByTestId("sidebar-project-workspace-list-scroll");
    await largeHeader.click();
    await expect(
      page.getByTestId(`sidebar-workspace-row-${getServerId()}:${large.workspaceId}`),
    ).toBeVisible();
    await expect(
      page
        .getByRole("group", { name: "Anchor 00", exact: true })
        .locator('[data-testid^="sidebar-workspace-row-"]'),
    ).toHaveCount(16);
    await smallHeader.scrollIntoViewIfNeeded();
    expect(await readScrollTop(scroll)).toBeGreaterThan(200);
    await smallHeader.evaluate((header) => {
      header.addEventListener(
        "click",
        () => {
          const viewport = header.closest('[data-testid="sidebar-project-workspace-list-scroll"]');
          if (!viewport) throw new Error("Project has no scroll owner");
          const samples: Array<{
            top: number;
            bottom: number;
            viewportTop: number;
            viewportBottom: number;
            scrollTop: number;
          }> = [];
          const start = performance.now();
          function afterPaint() {
            setTimeout(sample, 0);
          }
          const sample = () => {
            const row = header.getBoundingClientRect();
            const bounds = viewport.getBoundingClientRect();
            samples.push({
              top: row.top,
              bottom: row.bottom,
              viewportTop: bounds.top,
              viewportBottom: bounds.bottom,
              scrollTop: viewport.scrollTop,
            });
            if (performance.now() - start < 250) requestAnimationFrame(afterPaint);
            else header.setAttribute("data-anchor-samples", JSON.stringify(samples));
          };
          requestAnimationFrame(afterPaint);
        },
        { once: true },
      );
    });
    await smallHeader.click();
    await expect(smallHeader).toHaveAttribute("data-anchor-samples", /./);
    const samples = JSON.parse((await smallHeader.getAttribute("data-anchor-samples"))!) as Array<{
      top: number;
      bottom: number;
      viewportTop: number;
      viewportBottom: number;
      scrollTop: number;
    }>;
    expect(samples.length).toBeGreaterThan(2);
    for (const sample of samples) {
      expect(sample.top).toBeGreaterThanOrEqual(sample.viewportTop - 2);
      expect(sample.bottom).toBeLessThanOrEqual(sample.viewportBottom + 2);
    }
    expect(samples.at(-1)!.scrollTop).toBeLessThan(samples[0].scrollTop);
    // The selected project becomes topmost; preceding collapsed projects remain above the viewport.
    expect(samples.at(-1)!.scrollTop).toBeGreaterThan(0);
    expect(Math.abs(samples.at(-1)!.top - samples.at(-1)!.viewportTop)).toBeLessThanOrEqual(2);
    await expect(
      page.getByTestId(`sidebar-workspace-row-${getServerId()}:${large.workspaceId}`),
    ).toHaveCount(0);
    await expect(
      page.getByTestId(`sidebar-workspace-row-${getServerId()}:${small.workspaceId}`),
    ).toBeVisible();
    await testInfo.attach("accordion-animation-frames", {
      body: JSON.stringify(samples, null, 2),
      contentType: "application/json",
    });
    await page.screenshot({ path: testInfo.outputPath("accordion-selected-project.png") });
  } finally {
    for (const seed of projects.toReversed()) await seed.cleanup();
  }
});
