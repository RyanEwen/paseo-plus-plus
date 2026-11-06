import type { Locator, Page } from "@playwright/test";
import { defaultSidebarModeProfiles } from "../../src/stores/sidebar-mode-preferences";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { projectEquivalenceViewKey } from "../support/helpers/project-view-key";
import { seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import {
  seedSidebarMotionPreferences,
  startSidebarMotionProbe,
  stopSidebarMotionProbe,
  expectSidebarMotionPaused,
  resumeSidebarMotion,
} from "../support/helpers/sidebar-motion";
import { getServerId } from "../support/helpers/server-id";
import { seedWorkspace } from "../support/helpers/seed-client";
import {
  openSidebarDisplayPage,
  openMobileAgentSidebar,
  closeMobileAgentSidebar,
  expectMobileAgentSidebarHidden,
  selectSidebarStatusGrouping,
  selectSidebarProjectGrouping,
  sidebarWorkspaceSortMenuItem,
  closeSidebarDisplayPreferences,
} from "../support/helpers/sidebar";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

async function rowTestIds(rows: Locator) {
  return rows.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-testid")),
  );
}

async function visibleBoundingBox(row: Locator) {
  const box = await row.boundingBox();
  if (!box) throw new Error("Expected a visible draggable row");
  return box;
}

async function pressProjectRow(rows: Locator) {
  await rows.page().mouse.down();
}

async function pressWorkspaceRow(rows: Locator) {
  const solidScrimStop = rows
    .nth(0)
    .getByTestId("sidebar-workspace-trailing-scrim")
    .locator("stop")
    .nth(1);
  const hoverScrimColor = await solidScrimStop.getAttribute("stop-color");
  await rows.page().mouse.down();
  await expect.poll(() => solidScrimStop.getAttribute("stop-color")).not.toBe(hoverScrimColor);
}

async function quickDragFirstRowAfterSecond(
  rows: Locator,
  pressRow: (rows: Locator) => Promise<void>,
) {
  await expect(rows).toHaveCount(2);
  const before = await rowTestIds(rows);
  const sourceBox = await visibleBoundingBox(rows.nth(0));
  const targetBox = await visibleBoundingBox(rows.nth(1));

  const page = rows.page();
  const source = { x: sourceBox.x + sourceBox.width / 2, y: sourceBox.y + sourceBox.height / 2 };
  const target = { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height / 2 };

  await page.mouse.move(source.x, source.y);
  const trailingScrim = rows.nth(0).getByTestId("sidebar-workspace-trailing-scrim");
  await pressRow(rows);
  await page.mouse.move(source.x, source.y + 7);
  await expect(trailingScrim).toHaveCount(0);
  await page.mouse.move(target.x, target.y, { steps: 4 });
  await finishSidebarDrag(page);

  await expect.poll(() => rowTestIds(rows)).toEqual([before[1], before[0]]);
}

/** Attempt the same physical gesture while sorting owns order; disabled rows have no drag feedback. */
async function expectSortedDragBlocked(rows: Locator) {
  await expect(rows).toHaveCount(2);
  const before = await rowTestIds(rows);
  const source = await visibleBoundingBox(rows.nth(0));
  const target = await visibleBoundingBox(rows.nth(1));
  const page = rows.page();
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 });
  await finishSidebarDrag(page);
  await expect.poll(() => rowTestIds(rows)).toEqual(before);
}

test("projects, workspaces, and pinned chats reorder with an immediate mouse drag", async ({
  page,
}) => {
  const firstProject = await seedWorkspace({ repoPrefix: "sidebar-reorder-first-" });
  const secondProject = await seedWorkspace({ repoPrefix: "sidebar-reorder-second-" });

  try {
    const secondWorkspace = await firstProject.client.createWorkspace({
      source: {
        kind: "directory",
        path: firstProject.repoPath,
        projectId: firstProject.projectId,
      },
      title: "Second workspace",
    });
    if (!secondWorkspace.workspace) {
      throw new Error(secondWorkspace.error ?? "Failed to seed a second workspace");
    }

    await gotoAppShell(page);
    await waitForSidebarHydration(page);

    const firstProjectTestId = `sidebar-project-row-${projectEquivalenceViewKey(firstProject.projectKey)}`;
    const secondProjectTestId = `sidebar-project-row-${projectEquivalenceViewKey(secondProject.projectKey)}`;
    await quickDragFirstRowAfterSecond(
      page.locator(`[data-testid="${firstProjectTestId}"], [data-testid="${secondProjectTestId}"]`),
      pressProjectRow,
    );
    const firstWorkspaceTestId = `sidebar-workspace-row-${getServerId()}:${firstProject.workspaceId}`;
    const secondWorkspaceTestId = `sidebar-workspace-row-${getServerId()}:${secondWorkspace.workspace.id}`;
    const ordinaryRows = page.locator(
      `[data-testid="${firstWorkspaceTestId}"], [data-testid="${secondWorkspaceTestId}"]`,
    );
    await expect
      .poll(() => rowTestIds(ordinaryRows))
      .toEqual([secondWorkspaceTestId, firstWorkspaceTestId]);
    await selectWorkspaceSort(page, "Manual");
    await quickDragFirstRowAfterSecond(ordinaryRows, pressWorkspaceRow);
    await quickDragFirstRowAfterSecond(ordinaryRows, pressWorkspaceRow);
    await selectWorkspaceSort(page, "Created");
    await expect
      .poll(() => rowTestIds(ordinaryRows))
      .toEqual([secondWorkspaceTestId, firstWorkspaceTestId]);
    await dragWithoutReordering(ordinaryRows);

    await openSidebarDisplayPage(page, "sidebar-display-workspace-sorting");
    await page.getByTestId("sidebar-workspace-sorting-name").click();
    await firstProject.client.setWorkspacePinned(firstProject.workspaceId, true);
    await secondProject.client.setWorkspacePinned(secondProject.workspaceId, true);
    const secondProjectWorkspaceTestId = `sidebar-workspace-row-${getServerId()}:${secondProject.workspaceId}`;
    await quickDragFirstRowAfterSecond(
      page.locator(
        `[data-testid="${firstWorkspaceTestId}"], [data-testid="${secondProjectWorkspaceTestId}"]`,
      ),
      pressWorkspaceRow,
    );
  } finally {
    await firstProject.cleanup();
    await secondProject.cleanup();
  }
});

test("project sorting restores custom drag order and is hidden in status grouping", async ({
  page,
}, testInfo) => {
  const zeta = await seedWorkspace({ repoPrefix: "sidebar-sort-zeta-", title: "Zeta work" });
  const alpha = await seedWorkspace({ repoPrefix: "sidebar-sort-alpha-", title: "Alpha work" });
  const alphaId = `sidebar-project-row-${projectEquivalenceViewKey(alpha.projectKey)}`;
  const zetaId = `sidebar-project-row-${projectEquivalenceViewKey(zeta.projectKey)}`;
  try {
    await zeta.client.renameProject(zeta.projectId, "Zeta");
    await alpha.client.renameProject(alpha.projectId, "Alpha");
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    const rows = page.locator(`[data-testid="${alphaId}"], [data-testid="${zetaId}"]`);
    await expect(rows).toHaveCount(2);
    await openSidebarDisplayPage(page, "sidebar-display-sorting");
    await page.getByTestId("sidebar-sorting-project").click();
    await expect.poll(() => rowTestIds(rows)).toEqual([alphaId, zetaId]);
    await expectSortedDragBlocked(rows);
    await page.getByTestId("sidebar-display-preferences-menu").click();
    await expect(page.getByTestId("sidebar-display-sorting")).toContainText("Project name");
    await closeSidebarDisplayPreferences(page);
    await openSidebarDisplayPage(page, "sidebar-display-sorting");
    await page.getByTestId("sidebar-sorting-custom").click();
    if ((await rowTestIds(rows))[0] !== alphaId)
      await quickDragFirstRowAfterSecond(rows, pressProjectRow);
    await expect.poll(() => rowTestIds(rows)).toEqual([alphaId, zetaId]);
    await quickDragFirstRowAfterSecond(rows, pressProjectRow);
    await page.getByTestId("sidebar-display-preferences-menu").click();
    await expect(page.getByTestId("sidebar-display-sorting")).toContainText("Custom order");
    await closeSidebarDisplayPreferences(page);
    await openSidebarDisplayPage(page, "sidebar-display-sorting");
    await page.getByTestId("sidebar-sorting-project").click();
    await expect.poll(() => rowTestIds(rows)).toEqual([alphaId, zetaId]);
    await openSidebarDisplayPage(page, "sidebar-display-sorting");
    await page.getByTestId("sidebar-sorting-custom").click();
    await expect.poll(() => rowTestIds(rows)).toEqual([zetaId, alphaId]);
    await selectSidebarStatusGrouping(page);
    await page.getByTestId("sidebar-display-preferences-menu").click();
    await expect(page.getByTestId("sidebar-display-sorting")).toHaveCount(0);
    await closeSidebarDisplayPreferences(page);
    await selectSidebarProjectGrouping(page);
    await page.reload();
    await expect.poll(() => rowTestIds(rows)).toEqual([zetaId, alphaId]);
    await page.getByTestId("sidebar-display-preferences-menu").click();
    await expect(page.getByTestId("sidebar-display-sorting")).toContainText("Custom order");
    await page.screenshot({ path: testInfo.outputPath("sidebar-display-preferences.png") });
  } finally {
    await alpha.cleanup();
    await zeta.cleanup();
  }
});

test("empty-project sorting is contextual and restores custom drag order in status grouping", async ({
  page,
}) => {
  const zeta = await seedWorkspace({ repoPrefix: "empty-sort-zeta-" });
  const alpha = await seedWorkspace({ repoPrefix: "empty-sort-alpha-" });
  const occupied = await seedWorkspace({ repoPrefix: "empty-sort-occupied-" });
  const alphaId = `sidebar-project-row-${projectEquivalenceViewKey(alpha.projectKey)}`;
  const zetaId = `sidebar-project-row-${projectEquivalenceViewKey(zeta.projectKey)}`;
  try {
    await zeta.client.renameProject(zeta.projectId, "Zeta");
    await alpha.client.renameProject(alpha.projectId, "Alpha");
    await zeta.client.archiveWorkspace(zeta.workspaceId);
    await alpha.client.archiveWorkspace(alpha.workspaceId);
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await selectSidebarStatusGrouping(page);
    await openSidebarDisplayPage(page, "sidebar-display-empty-workspaces");
    await page.getByTestId("sidebar-empty-workspaces-group").click();
    const rows = page.locator(`[data-testid="${alphaId}"], [data-testid="${zetaId}"]`);
    await expect(rows).toHaveCount(2);
    const statusRows = page
      .getByTestId("sidebar-status-group-rows-done")
      .locator('[data-testid^="sidebar-workspace-row-"]');
    const initialWorkspaceOrder = await rowTestIds(statusRows);
    await openSidebarDisplayPage(page, "sidebar-display-empty-project-sorting");
    await expect(page.getByTestId("sidebar-empty-project-sorting-status")).toHaveCount(0);
    await page.getByTestId("sidebar-empty-project-sorting-project").click();
    await expect.poll(() => rowTestIds(rows)).toEqual([alphaId, zetaId]);
    await expectSortedDragBlocked(rows);
    await page.getByTestId("sidebar-display-preferences-menu").click();
    await expect(page.getByTestId("sidebar-display-empty-project-sorting")).toContainText(
      "Project name",
    );
    await closeSidebarDisplayPreferences(page);
    await openSidebarDisplayPage(page, "sidebar-display-empty-project-sorting");
    await page.getByTestId("sidebar-empty-project-sorting-custom").click();
    if ((await rowTestIds(rows))[0] !== alphaId)
      await quickDragFirstRowAfterSecond(rows, pressProjectRow);
    await expect.poll(() => rowTestIds(rows)).toEqual([alphaId, zetaId]);
    await quickDragFirstRowAfterSecond(rows, pressProjectRow);
    await page.getByTestId("sidebar-display-preferences-menu").click();
    await expect(page.getByTestId("sidebar-display-empty-project-sorting")).toContainText(
      "Custom order",
    );
    await expect(page.getByTestId("sidebar-display-sorting")).toHaveCount(0);
    await closeSidebarDisplayPreferences(page);
    await openSidebarDisplayPage(page, "sidebar-display-empty-project-sorting");
    await page.getByTestId("sidebar-empty-project-sorting-project").click();
    await expect.poll(() => rowTestIds(rows)).toEqual([alphaId, zetaId]);
    await page.reload();
    await expect.poll(() => rowTestIds(rows)).toEqual([alphaId, zetaId]);
    await openSidebarDisplayPage(page, "sidebar-display-empty-project-sorting");
    await page.getByTestId("sidebar-empty-project-sorting-custom").click();
    await expect.poll(() => rowTestIds(rows)).toEqual([zetaId, alphaId]);
    await expect.poll(() => rowTestIds(statusRows)).toEqual(initialWorkspaceOrder);
    await openSidebarDisplayPage(page, "sidebar-display-empty-workspaces");
    await page.getByTestId("sidebar-empty-workspaces-show").click();
    await page.getByTestId("sidebar-display-preferences-menu").click();
    await expect(page.getByTestId("sidebar-display-empty-project-sorting")).toHaveCount(0);
    await closeSidebarDisplayPreferences(page);
    await openSidebarDisplayPage(page, "sidebar-display-empty-workspaces");
    await page.getByTestId("sidebar-empty-workspaces-group").click();
    await expect.poll(() => rowTestIds(rows)).toEqual([zetaId, alphaId]);
    await openSidebarDisplayPage(page, "sidebar-display-empty-workspaces");
    await page.getByTestId("sidebar-empty-workspaces-hide").click();
    await page.getByTestId("sidebar-display-preferences-menu").click();
    await expect(page.getByTestId("sidebar-display-empty-project-sorting")).toHaveCount(0);
    await closeSidebarDisplayPreferences(page);
  } finally {
    await occupied.cleanup();
    await alpha.cleanup();
    await zeta.cleanup();
  }
});

/** Seed two workspace rows whose names expose alphabetical and saved drag order. */
async function seedSortableWorkspaceRows(page: Page) {
  const first = await seedWorkspace({ repoPrefix: "sidebar-workspace-sort-", title: "Zeta" });
  try {
    const created = await first.client.createWorkspace({
      source: { kind: "directory", path: first.repoPath, projectId: first.projectId },
      title: "Alpha",
    });
    if (!created.workspace) throw new Error(created.error ?? "Failed to create workspace");
    const zetaId = `sidebar-workspace-row-${getServerId()}:${first.workspaceId}`;
    const alphaId = `sidebar-workspace-row-${getServerId()}:${created.workspace.id}`;
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    return {
      rows: page.locator(`[data-testid="${alphaId}"], [data-testid="${zetaId}"]`),
      alphaId,
      zetaId,
      cleanup: first.cleanup,
    };
  } catch (error) {
    await first.cleanup();
    throw error;
  }
}

/** Verify that alphabetical sorting leaves drag order available and saved across reloads. */
async function expectWorkspaceSortingRestoresCustomOrder(
  page: Page,
  { rows, alphaId, zetaId }: Awaited<ReturnType<typeof seedSortableWorkspaceRows>>,
) {
  await openSidebarDisplayPage(page, "sidebar-display-workspace-sorting");
  await page.getByTestId("sidebar-workspace-sorting-name").click();
  await expect.poll(() => rowTestIds(rows)).toEqual([alphaId, zetaId]);
  await expectSortedDragBlocked(rows);
  await page.getByTestId("sidebar-display-preferences-menu").click();
  await expect(page.getByTestId("sidebar-display-workspace-sorting")).toContainText(
    "Workspace name",
  );
  await closeSidebarDisplayPreferences(page);
  await openSidebarDisplayPage(page, "sidebar-display-workspace-sorting");
  await page.getByTestId("sidebar-workspace-sorting-custom").click();
  if ((await rowTestIds(rows))[0] !== alphaId)
    await quickDragFirstRowAfterSecond(rows, pressWorkspaceRow);
  await expect.poll(() => rowTestIds(rows)).toEqual([alphaId, zetaId]);
  await quickDragFirstRowAfterSecond(rows, pressWorkspaceRow);
  await page.getByTestId("sidebar-display-preferences-menu").click();
  await expect(page.getByTestId("sidebar-display-workspace-sorting")).toContainText("Custom order");
  await closeSidebarDisplayPreferences(page);
  await openSidebarDisplayPage(page, "sidebar-display-workspace-sorting");
  await page.getByTestId("sidebar-workspace-sorting-name").click();
  await expect.poll(() => rowTestIds(rows)).toEqual([alphaId, zetaId]);
  await openSidebarDisplayPage(page, "sidebar-display-workspace-sorting");
  await page.getByTestId("sidebar-workspace-sorting-custom").click();
  await expect.poll(() => rowTestIds(rows)).toEqual([zetaId, alphaId]);
  await page.reload();
  await expect.poll(() => rowTestIds(rows)).toEqual([zetaId, alphaId]);
}

test("workspace sorting restores custom drag order in project grouping", async ({ page }) => {
  const seeded = await seedSortableWorkspaceRows(page);
  try {
    await expectWorkspaceSortingRestoresCustomOrder(page, seeded);
  } finally {
    await seeded.cleanup();
  }
});

test("workspace sorting restores custom drag order in status grouping", async ({ page }) => {
  const seeded = await seedSortableWorkspaceRows(page);
  try {
    await selectSidebarStatusGrouping(page);
    await expectWorkspaceSortingRestoresCustomOrder(page, seeded);
  } finally {
    await seeded.cleanup();
  }
});

test("status sorting puts the newest matching workspace first in project grouping", async ({
  page,
}, testInfo) => {
  const seeded = await seedSortableWorkspaceRows(page);
  try {
    await selectSidebarProjectGrouping(page);
    // Alpha was created second. Save the older Zeta first to distinguish recency from drag order.
    await openSidebarDisplayPage(page, "sidebar-display-workspace-sorting");
    await page.getByTestId("sidebar-workspace-sorting-name").click();
    await expect.poll(() => rowTestIds(seeded.rows)).toEqual([seeded.alphaId, seeded.zetaId]);
    await openSidebarDisplayPage(page, "sidebar-display-workspace-sorting");
    await page.getByTestId("sidebar-workspace-sorting-custom").click();
    if ((await rowTestIds(seeded.rows))[0] !== seeded.alphaId)
      await quickDragFirstRowAfterSecond(seeded.rows, pressWorkspaceRow);
    await expect.poll(() => rowTestIds(seeded.rows)).toEqual([seeded.alphaId, seeded.zetaId]);
    await quickDragFirstRowAfterSecond(seeded.rows, pressWorkspaceRow);
    await openSidebarDisplayPage(page, "sidebar-display-workspace-sorting");
    await page.getByTestId("sidebar-workspace-sorting-status").click();
    await expect.poll(() => rowTestIds(seeded.rows)).toEqual([seeded.alphaId, seeded.zetaId]);
    await page.screenshot({ path: testInfo.outputPath("project-status-newest-first.png") });
    await page.reload();
    await expect.poll(() => rowTestIds(seeded.rows)).toEqual([seeded.alphaId, seeded.zetaId]);
    await openSidebarDisplayPage(page, "sidebar-display-workspace-sorting");
    await page.getByTestId("sidebar-workspace-sorting-custom").click();
    await expect.poll(() => rowTestIds(seeded.rows)).toEqual([seeded.zetaId, seeded.alphaId]);
    await selectSidebarStatusGrouping(page);
    await openSidebarDisplayPage(page, "sidebar-display-workspace-sorting");
    await page.getByTestId("sidebar-workspace-sorting-status").click();
    await expect.poll(() => rowTestIds(seeded.rows)).toEqual([seeded.alphaId, seeded.zetaId]);
  } finally {
    await seeded.cleanup();
  }
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`status moves keep row identity, focus and rename drafts at ${viewport.width}px`, async ({
    page,
  }, testInfo) => {
    const subject = await seedMockAgentWorkspace({
      repoPrefix: "sidebar-motion-subject-",
      title: "Subject",
      initialPrompt: "Finish.",
    });
    const other = await seedMockAgentWorkspace({
      repoPrefix: "sidebar-motion-other-",
      title: "Other",
      initialPrompt: "Finish.",
    });
    try {
      await subject.client.waitForFinish(subject.agentId, 20_000);
      await other.client.waitForFinish(other.agentId, 20_000);
      await subject.client.clearWorkspaceAttention(subject.workspaceId);
      await other.client.clearWorkspaceAttention(other.workspaceId);
      await page.setViewportSize(viewport);
      await seedSidebarMotionPreferences({ page, enabled: true });
      await gotoAppShell(page);
      if (viewport.width < 600) await openMobileAgentSidebar(page);
      const key = `${getServerId()}:${subject.workspaceId}`;
      const rowTestId = `sidebar-workspace-row-${key}`;
      const row = page.getByTestId(rowTestId);
      await expect(row).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByTestId(`sidebar-workspace-row-${getServerId()}:${other.workspaceId}`),
      ).toBeVisible();
      // Visibility starts during the compact drawer's entrance. Wait for real actionability
      // before measuring the independent row transition, without clicking or changing focus.
      await row.click({ trial: true });
      await row.focus();
      await page.screenshot({ path: testInfo.outputPath("motion-before.png") });
      await startSidebarMotionProbe({ page, rowTestId, freeze: true });
      await subject.client.markWorkspaceUnread(subject.workspaceId);
      await expectSidebarMotionPaused(page);
      await page.screenshot({ path: testInfo.outputPath("motion-middle.png") });
      await expect(row).toBeFocused();
      await resumeSidebarMotion(page);
      await expect
        .poll(async () =>
          row.evaluate(
            (node) => node.closest("[data-position-transition]")?.getAnimations().length ?? 0,
          ),
        )
        .toBe(0);
      await page.screenshot({ path: testInfo.outputPath("motion-after.png") });
      const frames = await stopSidebarMotionProbe(page);
      expect(frames.every((frame) => frame.connected && frame.sameNode)).toBe(true);
      expect(frames.some((frame) => frame.duration === 100)).toBe(true);
      expect(new Set(frames.map((frame) => Math.round(frame.top))).size).toBeGreaterThan(2);
      await testInfo.attach("motion-frames.json", {
        body: JSON.stringify(frames),
        contentType: "application/json",
      });

      await row.hover();
      await page.getByTestId(`sidebar-workspace-kebab-${key}`).click();
      await page.getByTestId(`sidebar-workspace-menu-rename-${key}`).click();
      const input = page.getByTestId(`sidebar-workspace-rename-modal-${key}-input`);
      await input.fill("Unsaved rename survives movement");
      await subject.client.clearWorkspaceAttention(subject.workspaceId);
      await expect(
        page.getByTestId("sidebar-status-group-rows-done").getByTestId(rowTestId),
      ).toBeVisible();
      await expect(input).toHaveValue("Unsaved rename survives movement");
      await expect(input).toBeFocused();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      if (viewport.width < 600) {
        await closeMobileAgentSidebar(page);
        await expectMobileAgentSidebarHidden(page);
        await subject.client.markWorkspaceUnread(subject.workspaceId);
        await expect(row.getByTestId("workspace-status-indicator-attention")).toHaveCount(1);
        await startSidebarMotionProbe({ page, rowTestId });
        await openMobileAgentSidebar(page);
        await expect(row).toBeInViewport();
        const revealedFrames = await stopSidebarMotionProbe(page);
        expect(revealedFrames.every((frame) => frame.duration === null && frame.sameNode)).toBe(
          true,
        );
        await page.screenshot({ path: testInfo.outputPath("hidden-status-reveal.png") });
      } else {
        await page.keyboard.press("Control+b");
        await expect(row).not.toBeVisible();
        await expect
          .poll(() =>
            row.evaluate((node) => {
              for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
                if (getComputedStyle(ancestor).display === "none") return true;
              }
              return false;
            }),
          )
          .toBe(true);
        await subject.client.markWorkspaceUnread(subject.workspaceId);
        await expect(row.getByTestId("workspace-status-indicator-attention")).toHaveCount(1);
        await startSidebarMotionProbe({ page, rowTestId });
        await page.keyboard.press("Control+b");
        await expect(row).toBeVisible();
        const revealedFrames = await stopSidebarMotionProbe(page);
        expect(revealedFrames.every((frame) => frame.duration === null && frame.sameNode)).toBe(
          true,
        );
        await page.screenshot({ path: testInfo.outputPath("desktop-hidden-status-reveal.png") });
      }
    } finally {
      await subject.cleanup();
      await other.cleanup();
    }
  });
}

for (const mode of ["off", "reduced"] as const) {
  test(`status moves instantly with motion ${mode} and retains the setting after reload`, async ({
    page,
  }) => {
    const subject = await seedMockAgentWorkspace({
      repoPrefix: "sidebar-motion-instant-",
      title: "Subject",
      initialPrompt: "Finish.",
    });
    try {
      await subject.client.waitForFinish(subject.agentId, 20_000);
      await subject.client.clearWorkspaceAttention(subject.workspaceId);
      await seedSidebarMotionPreferences({ page, enabled: true });
      await page.emulateMedia({ reducedMotion: mode === "reduced" ? "reduce" : "no-preference" });
      await gotoAppShell(page);
      if (mode === "off") {
        await page.goto("/settings/paseo-plus-plus");
        const toggle = page.getByRole("switch", { name: "Animate workspace moves", exact: true });
        await expect(toggle).toBeChecked();
        await toggle.click();
        await expect(toggle).not.toBeChecked();
        await gotoAppShell(page);
      }
      const rowTestId = `sidebar-workspace-row-${getServerId()}:${subject.workspaceId}`;
      await expect(page.getByTestId(rowTestId)).toBeVisible({ timeout: 30_000 });
      for (const reload of [false, true]) {
        if (reload) {
          await page.reload();
          await expect(page.getByTestId(rowTestId)).toBeVisible({ timeout: 30_000 });
        }
        await startSidebarMotionProbe({ page, rowTestId });
        await subject.client.markWorkspaceUnread(subject.workspaceId);
        await expect(
          page.getByTestId("sidebar-status-group-rows-attention").getByTestId(rowTestId),
        ).toBeVisible();
        const frames = await stopSidebarMotionProbe(page);
        expect(frames.every((frame) => frame.duration === null && frame.sameNode)).toBe(true);
        await subject.client.clearWorkspaceAttention(subject.workspaceId);
        await expect(
          page.getByTestId("sidebar-status-group-rows-done").getByTestId(rowTestId),
        ).toBeVisible();
      }
    } finally {
      await subject.cleanup();
    }
  });
}

test("rapid status reversal starts from the interrupted painted position", async ({ page }) => {
  const subject = await seedMockAgentWorkspace({
    repoPrefix: "sidebar-motion-interrupt-",
    title: "Subject",
    initialPrompt: "Finish.",
  });
  const other = await seedMockAgentWorkspace({
    repoPrefix: "sidebar-motion-interrupt-other-",
    title: "Other",
    initialPrompt: "Finish.",
  });
  try {
    await subject.client.waitForFinish(subject.agentId, 20_000);
    await other.client.waitForFinish(other.agentId, 20_000);
    await subject.client.clearWorkspaceAttention(subject.workspaceId);
    await other.client.clearWorkspaceAttention(other.workspaceId);
    await seedSidebarMotionPreferences({ page, enabled: true });
    await gotoAppShell(page);
    const rowTestId = `sidebar-workspace-row-${getServerId()}:${subject.workspaceId}`;
    const row = page.getByTestId(rowTestId);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await startSidebarMotionProbe({ page, rowTestId, freeze: true });
    await subject.client.markWorkspaceUnread(subject.workspaceId);
    await expectSidebarMotionPaused(page);
    const interruptedTop = (await row.boundingBox())!.y;
    await subject.client.clearWorkspaceAttention(subject.workspaceId);
    await expect(
      page.getByTestId("sidebar-status-group-rows-done").getByTestId(rowTestId),
    ).toBeVisible();
    await expect
      .poll(async () =>
        row.evaluate(
          (node) => node.closest("[data-position-transition]")?.getAnimations().length ?? 0,
        ),
      )
      .toBe(0);
    const frames = await stopSidebarMotionProbe(page);
    const firstReturn = frames.find(
      (frame, index) =>
        index > 0 &&
        frame.group === "sidebar-status-group-rows-done" &&
        frames
          .slice(0, index)
          .some((prior) => prior.group === "sidebar-status-group-rows-attention"),
    );
    expect(firstReturn).toBeDefined();
    expect(Math.abs(firstReturn!.top - interruptedTop)).toBeLessThan(12);
    expect(frames.every((frame) => frame.sameNode && frame.connected)).toBe(true);

    // The newly completed subject is first in Done. Changing only its bucket
    // keeps the same layout position and must not create artificial movement.
    const stationaryTop = (await row.boundingBox())!.y;
    await startSidebarMotionProbe({ page, rowTestId });
    await subject.client.markWorkspaceUnread(subject.workspaceId);
    await expect(
      page.getByTestId("sidebar-status-group-rows-attention").getByTestId(rowTestId),
    ).toBeVisible();
    const stationaryFrames = await stopSidebarMotionProbe(page);
    expect(stationaryFrames.length).toBeGreaterThan(0);
    expect(
      stationaryFrames.every(
        (frame) =>
          frame.duration === null &&
          frame.sameNode &&
          frame.connected &&
          Math.abs(frame.top - stationaryTop) < 1,
      ),
    ).toBe(true);
    await subject.client.clearWorkspaceAttention(subject.workspaceId);

    // Completing the other workspace puts it ahead of the subject. The next
    // bucket change now has real displacement for live reduced-motion cancellation.
    await other.client.markWorkspaceUnread(other.workspaceId);
    await other.client.clearWorkspaceAttention(other.workspaceId);
    const doneRows = page
      .getByTestId("sidebar-status-group-rows-done")
      .locator('[data-testid^="sidebar-workspace-row-"]');
    await expect
      .poll(() => rowTestIds(doneRows))
      .toEqual([`sidebar-workspace-row-${getServerId()}:${other.workspaceId}`, rowTestId]);
    await expect
      .poll(() =>
        row.evaluate(
          (node) => node.closest("[data-position-transition]")?.getAnimations().length ?? 0,
        ),
      )
      .toBe(0);
    await startSidebarMotionProbe({ page, rowTestId, freeze: true });
    await subject.client.markWorkspaceUnread(subject.workspaceId);
    await expectSidebarMotionPaused(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect
      .poll(async () =>
        row.evaluate(
          (node) => node.closest("[data-position-transition]")?.getAnimations().length ?? 0,
        ),
      )
      .toBe(0);
    const reducedFrames = await stopSidebarMotionProbe(page);
    expect(reducedFrames.every((frame) => frame.sameNode && frame.connected)).toBe(true);
  } finally {
    await subject.cleanup();
    await other.cleanup();
  }
});

test("collapsed destinations preserve drafts, collapse choices and conditional row focus", async ({
  page,
}) => {
  const subject = await seedMockAgentWorkspace({
    repoPrefix: "sidebar-motion-hidden-",
    title: "Subject",
    initialPrompt: "Finish.",
  });
  const other = await seedMockAgentWorkspace({
    repoPrefix: "sidebar-motion-hidden-other-",
    title: "Other",
    initialPrompt: "Finish.",
  });
  try {
    await subject.client.waitForFinish(subject.agentId, 20_000);
    await other.client.waitForFinish(other.agentId, 20_000);
    await subject.client.clearWorkspaceAttention(subject.workspaceId);
    await other.client.clearWorkspaceAttention(other.workspaceId);
    await other.client.markWorkspaceUnread(other.workspaceId);
    await seedSidebarMotionPreferences({ page, enabled: true });
    await gotoAppShell(page);
    const key = `${getServerId()}:${subject.workspaceId}`;
    const row = page.getByTestId(`sidebar-workspace-row-${key}`);
    const header = page.getByTestId("sidebar-status-group-attention");
    await expect(row).toBeVisible({ timeout: 30_000 });
    await header.click();
    const collapsedBefore = await page.evaluate(() =>
      localStorage.getItem("sidebar-collapsed-sections"),
    );
    await row.hover();
    await page.getByTestId(`sidebar-workspace-kebab-${key}`).click();
    await page.getByTestId(`sidebar-workspace-menu-rename-${key}`).click();
    const input = page.getByTestId(`sidebar-workspace-rename-modal-${key}-input`);
    await input.fill("Keep this hidden-row draft");
    await subject.client.markWorkspaceUnread(subject.workspaceId);
    await expect(row).toHaveCount(0);
    await expect(input).toHaveValue("Keep this hidden-row draft");
    await expect(input).toBeFocused();
    expect(await page.evaluate(() => localStorage.getItem("sidebar-collapsed-sections"))).toBe(
      collapsedBefore,
    );
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await subject.client.clearWorkspaceAttention(subject.workspaceId);
    await expect(row).toBeVisible();
    await row.focus();
    await subject.client.markWorkspaceUnread(subject.workspaceId);
    await expect(row).toHaveCount(0);
    await expect(header).toBeFocused();
    expect(await page.evaluate(() => localStorage.getItem("sidebar-collapsed-sections"))).toBe(
      collapsedBefore,
    );
    const collapsedKeys = await page.evaluate(() => {
      const stored = localStorage.getItem("sidebar-collapsed-sections");
      return stored ? JSON.parse(stored).state.collapsedWorkspaceGroupKeys : [];
    });
    expect(collapsedKeys).toContain("attention");
    await expect(page.getByTestId("sidebar-status-group-rows-attention")).toHaveCount(0);
  } finally {
    await subject.cleanup();
    await other.cleanup();
  }
});

for (const destination of ["collapsed", "limit"] as const) {
  test(`a header clipped above the sidebar scrollport cannot receive focus for a ${destination} destination`, async ({
    page,
  }, testInfo) => {
    const subject = await seedMockAgentWorkspace({
      repoPrefix: "sidebar-clipped-focus-subject-",
      title: "Subject",
      initialPrompt: "Finish.",
    });
    const other = await seedMockAgentWorkspace({
      repoPrefix: "sidebar-clipped-focus-other-",
      title: "Other",
      initialPrompt: "Finish.",
    });
    try {
      await subject.client.waitForFinish(subject.agentId, 20_000);
      await other.client.waitForFinish(other.agentId, 20_000);
      await subject.client.setWorkspaceTitle(subject.workspaceId, "Zeta");
      await other.client.setWorkspaceTitle(other.workspaceId, "Alpha");
      await subject.client.clearWorkspaceAttention(subject.workspaceId);
      await other.client.clearWorkspaceAttention(other.workspaceId);
      for (let index = 0; index < 21; index++) {
        const workspace = await other.client.createWorkspace({
          source: { kind: "directory", path: other.cwd },
          title: `Alpha ${index}`,
        });
        if (!workspace.workspace)
          throw new Error(workspace.error ?? "Could not seed sidebar scroll range");
      }
      if (destination === "collapsed") await other.client.markWorkspaceUnread(other.workspaceId);
      else await subject.client.markWorkspaceUnread(subject.workspaceId);
      await seedSidebarMotionPreferences({
        page,
        enabled: true,
        workspaceSortMode: destination === "limit" ? "name" : "status",
      });
      await page.setViewportSize({ width: 1440, height: 900 });
      await gotoAppShell(page);
      const row = page.getByTestId(`sidebar-workspace-row-${getServerId()}:${subject.workspaceId}`);
      const bucket = destination === "collapsed" ? "attention" : "done";
      const header = page.getByTestId(`sidebar-status-group-${bucket}`);
      if (destination === "collapsed") {
        // Blank workspaces deliberately fill the initial limit. Reveal the source
        // during setup without changing the collapsed destination on status moves.
        await page.getByTestId("sidebar-status-group-show-more-done").click();
      }
      await expect(row).toBeVisible({ timeout: 30_000 });
      if (destination === "collapsed") await header.click();
      const collapseBefore = await page.evaluate(() =>
        localStorage.getItem("sidebar-collapsed-sections"),
      );
      await row.focus();
      await header.evaluate((element) => {
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          const overflow = getComputedStyle(parent).overflowY;
          if (overflow !== "auto" && overflow !== "scroll") continue;
          const headerBounds = element.getBoundingClientRect();
          const scrollBounds = parent.getBoundingClientRect();
          parent.scrollTop += headerBounds.bottom - scrollBounds.top + 1;
          return;
        }
        throw new Error("No sidebar scrollport");
      });
      const clipping = await header.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          const overflow = getComputedStyle(parent).overflowY;
          if (overflow === "auto" || overflow === "scroll")
            return {
              top: bounds.top,
              bottom: bounds.bottom,
              scrollTop: parent.getBoundingClientRect().top,
            };
        }
        throw new Error("No sidebar scrollport");
      });
      expect(clipping.top).toBeGreaterThan(0);
      expect(clipping.bottom).toBeLessThan(clipping.scrollTop);
      await expect(row).toBeFocused();
      await page.screenshot({ path: testInfo.outputPath(`${destination}-header-clipped.png`) });
      if (destination === "collapsed")
        await subject.client.markWorkspaceUnread(subject.workspaceId);
      else await subject.client.clearWorkspaceAttention(subject.workspaceId);
      await expect(row).toHaveCount(0);
      await expect(header).not.toBeFocused();
      expect(await page.evaluate(() => localStorage.getItem("sidebar-collapsed-sections"))).toBe(
        collapseBefore,
      );
      if (destination === "limit") {
        await expect(
          page
            .getByTestId("sidebar-status-group-rows-done")
            .locator('[data-testid^="sidebar-workspace-row-"]'),
        ).toHaveCount(20);
        await expect(page.getByTestId("sidebar-status-group-show-more-done")).toContainText(
          "Show more",
        );
      }
    } finally {
      await subject.cleanup();
      await other.cleanup();
    }
  });
}
async function selectWorkspaceSort(page: Page, name: "Manual" | "Created" | "Last prompt") {
  await page.getByTestId("sidebar-display-preferences-menu").click();
  await sidebarWorkspaceSortMenuItem(page).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}

async function reconnectSidebar(page: Page): Promise<void> {
  await page.reload();
  await waitForSidebarHydration(page);
}

async function expectNoWorkspaceSortChoice(page: Page): Promise<void> {
  await page.getByTestId("sidebar-display-preferences-menu").click();
  await expect(sidebarWorkspaceSortMenuItem(page)).toHaveCount(0);
}

async function promptWorkspace(seed: Awaited<ReturnType<typeof seedWorkspace>>, agentId: string) {
  await seed.client.sendAgentMessage(agentId, "sidebar ordering check");
  expect((await seed.client.waitForFinish(agentId, 30_000)).status).toBe("idle");
}

test("Created stays stable, Last prompt follows human submissions and survives tab archive", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const seed = await seedWorkspace({ repoPrefix: "sidebar-sort-" });
  try {
    const newer = await seed.client.createWorkspace({
      source: { kind: "directory", path: seed.repoPath, projectId: seed.projectId },
      title: "Newer workspace",
    });
    if (!newer.workspace) throw new Error(newer.error ?? "Workspace creation failed");
    const agent = await seed.client.createAgent({
      provider: "mock",
      cwd: seed.repoPath,
      workspaceId: seed.workspaceId,
      modeId: "load-test",
      model: "e2e-fast-stream",
      title: "Ordering agent",
    });
    const newerAgent = await seed.client.createAgent({
      provider: "mock",
      cwd: seed.repoPath,
      workspaceId: newer.workspace.id,
      modeId: "load-test",
      model: "e2e-fast-stream",
      title: "Newer agent",
    });
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    const oldId = `sidebar-workspace-row-${getServerId()}:${seed.workspaceId}`;
    const newId = `sidebar-workspace-row-${getServerId()}:${newer.workspace.id}`;
    const rows = page.locator(`[data-testid="${oldId}"], [data-testid="${newId}"]`);
    await expect.poll(() => rowTestIds(rows)).toEqual([newId, oldId]);
    await promptWorkspace(seed, agent.id);
    await expect.poll(() => rowTestIds(rows)).toEqual([newId, oldId]);
    await selectWorkspaceSort(page, "Last prompt");
    await expect.poll(() => rowTestIds(rows)).toEqual([oldId, newId]);
    await promptWorkspace(seed, newerAgent.id);
    await expect.poll(() => rowTestIds(rows)).toEqual([newId, oldId]);
    await promptWorkspace(seed, agent.id);
    await expect.poll(() => rowTestIds(rows)).toEqual([oldId, newId]);
    await seed.client.archiveAgent(agent.id);
    await expect.poll(() => rowTestIds(rows)).toEqual([oldId, newId]);
    await reconnectSidebar(page);
    await expect.poll(() => rowTestIds(rows)).toEqual([oldId, newId]);
    await selectWorkspaceSort(page, "Created");
    await expect.poll(() => rowTestIds(rows)).toEqual([newId, oldId]);
    await selectSidebarStatusGrouping(page);
    await expectNoWorkspaceSortChoice(page);
  } finally {
    await seed.cleanup();
  }
});

async function seedCompactProject() {
  const seed = await seedWorkspace({
    repoPrefix: "sidebar-visibility-",
    title: "Oldest workspace",
  });
  const ids = [seed.workspaceId];
  for (let index = 2; index <= 12; index += 1) {
    const created = await seed.client.createWorkspace({
      source: { kind: "directory", path: seed.repoPath, projectId: seed.projectId },
      title: `Workspace ${index}`,
    });
    if (!created.workspace) throw new Error(created.error ?? "Workspace creation failed");
    ids.unshift(created.workspace.id);
  }
  const agent = await seed.client.createAgent({
    provider: "mock",
    model: "e2e-fast-stream",
    modeId: "load-test",
    cwd: seed.repoPath,
    workspaceId: seed.workspaceId,
    title: "Overflow agent",
  });
  return { seed, ids, agent };
}

async function expectWorkspaceOrder(rows: Locator, ids: string[]) {
  await expect
    .poll(() => rowTestIds(rows))
    .toEqual(ids.map((id) => `sidebar-workspace-row-${getServerId()}:${id}`));
}

async function revealWorkspaces(list: Locator, action: "Show more" | "Show less") {
  await list.getByLabel(action, { exact: true }).click();
}

type CompactProject = Awaited<ReturnType<typeof seedCompactProject>>;

function compactProjectRows(page: Page, seed: CompactProject["seed"]) {
  const list = page.getByTestId(`sidebar-workspace-list-${seed.projectKey}`);
  return {
    rows: list.locator('[data-testid^="sidebar-workspace-row-"]'),
    group: list.locator(".."),
    project: page.getByTestId(`sidebar-project-row-${projectEquivalenceViewKey(seed.projectKey)}`),
  };
}

/** Configure the fixed-seven fixture without changing default sidebar profiles. */
async function seedSevenWorkspaceScene(page: Page, includeStatus: boolean) {
  const modeProfiles = defaultSidebarModeProfiles();
  modeProfiles.project.initialWorkspaceCount = 7;
  if (includeStatus) modeProfiles.status.initialWorkspaceCount = 7;
  await page.addInitScript((profiles) => {
    localStorage.setItem(
      "sidebar-view",
      JSON.stringify({
        version: 12,
        state: { groupMode: "project", workspaceSort: "created", modeProfiles: profiles },
      }),
    );
  }, modeProfiles);
}

async function expectActiveOverflowTransitions(page: Page, { seed, ids, agent }: CompactProject) {
  const { rows } = compactProjectRows(page, seed);
  await expectWorkspaceOrder(rows, ids.slice(0, 7));

  await seed.client.sendAgentMessage(agent.id, "show active overflow");
  await expectWorkspaceOrder(rows, [...ids.slice(0, 7), ids[11]]);
  await seed.client.waitForFinish(agent.id, 15_000);
  await expectWorkspaceOrder(rows, [...ids.slice(0, 7), ids[11]]);
  await seed.client.clearWorkspaceAttention(seed.workspaceId);
  await expectWorkspaceOrder(rows, ids.slice(0, 7));
}

async function expectRevealSurvivesSortingAndCollapse(
  page: Page,
  { seed, ids, agent }: CompactProject,
) {
  const { rows, group, project } = compactProjectRows(page, seed);
  const retainedRows = await rows.elementHandles();
  await revealWorkspaces(group, "Show more");
  await expectWorkspaceOrder(rows, ids);
  for (const [index, retained] of retainedRows.entries()) {
    expect(
      await rows.nth(index).evaluate((current, previous) => current === previous, retained),
    ).toBe(true);
  }
  await project.click();
  await expect(rows).toHaveCount(0);
  await project.click();
  await expectWorkspaceOrder(rows, ids);
  await seed.client.sendAgentMessage(agent.id, "expanded overflow");
  await seed.client.waitForFinish(agent.id, 15_000);
  await seed.client.clearWorkspaceAttention(seed.workspaceId);
  await expectWorkspaceOrder(rows, ids);
  await selectWorkspaceSort(page, "Last prompt");
  await expectWorkspaceOrder(rows, [ids[11], ...ids.slice(0, 11)]);
  const revealedRow = await rows.nth(8).elementHandle();
  await revealWorkspaces(group, "Show less");
  await expectWorkspaceOrder(rows, [ids[11], ...ids.slice(0, 6)]);
  await selectWorkspaceSort(page, "Created");
  await expectWorkspaceOrder(rows, ids.slice(0, 7));
  expect(await revealedRow!.evaluate((row) => row.isConnected)).toBe(false);
  await reconnectSidebar(page);
  await expectWorkspaceOrder(rows, ids.slice(0, 7));
}

async function expectStatusBucketsRetainActiveOverflow(
  page: Page,
  { seed, ids, agent }: CompactProject,
) {
  const { rows } = compactProjectRows(page, seed);
  await selectSidebarStatusGrouping(page);
  const done = page.getByTestId("sidebar-status-group-rows-done");
  const doneRows = done.locator('[data-testid^="sidebar-workspace-row-"]');
  await expect(doneRows).toHaveCount(7);
  const doneToggle = page.getByTestId("sidebar-status-group-show-more-done");
  await expect(doneToggle).toHaveCount(1);
  await expect(doneToggle).toHaveAttribute("aria-label", "Show more");
  await doneToggle.click();
  await expect(doneRows).toHaveCount(12);
  await seed.client.sendAgentMessage(agent.id, "status overflow");
  await seed.client.waitForFinish(agent.id, 15_000);
  await expect(
    page
      .getByTestId("sidebar-status-group-rows-attention")
      .getByText("Oldest workspace", { exact: true }),
  ).toBeVisible();
  await expect(doneRows).toHaveCount(11);
  await seed.client.clearWorkspaceAttention(seed.workspaceId);
  await expect(doneRows).toHaveCount(12);
  await expect(doneToggle).toHaveCount(1);
  await expect(doneToggle).toHaveAttribute("aria-label", "Show less");
  await doneToggle.click();
  await expect(doneRows).toHaveCount(7);
  const activeAgents: Array<{ id: string }> = [];
  for (const workspaceId of ids.slice(0, 8)) {
    activeAgents.push(
      await seed.client.createAgent({
        provider: "mock",
        model: "e2e-fast-stream",
        modeId: "load-test",
        cwd: seed.repoPath,
        workspaceId,
        title: "Active overflow agent",
      }),
    );
  }
  await Promise.all(
    activeAgents.map((item) => seed.client.sendAgentMessage(item.id, "active bucket")),
  );
  await Promise.all(activeAgents.map((item) => seed.client.waitForFinish(item.id, 15_000)));
  const attention = page.getByTestId("sidebar-status-group-rows-attention");
  await expect(attention.locator('[data-testid^="sidebar-workspace-row-"]')).toHaveCount(8);
  await expect(page.getByTestId("sidebar-status-group-show-more-attention")).toHaveCount(0);
  for (const workspaceId of ids.slice(0, 8)) await seed.client.clearWorkspaceAttention(workspaceId);
  await expect(doneRows).toHaveCount(7);
  await selectSidebarProjectGrouping(page);
  await expectWorkspaceOrder(rows, ids.slice(0, 7));
}

test("compact groups retain active overflow and reveal the current ordered rows", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await seedSevenWorkspaceScene(page, true);
  const fixture = await seedCompactProject();
  try {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await test.step("Active overflow appears without intervening Done rows", () =>
      expectActiveOverflowTransitions(page, fixture));
    await test.step("Reveal follows current sort and survives collapse", () =>
      expectRevealSurvivesSortingAndCollapse(page, fixture));
    await test.step("Status reveals Done rows and keeps every active row", () =>
      expectStatusBucketsRetainActiveOverflow(page, fixture));
  } finally {
    await fixture.seed.cleanup();
  }
});

async function restorePreBetaOrder(page: Page, projectKey: string, workspaceKeys: string[]) {
  await page.evaluate(
    ({ projectKey: scope, workspaceKeys: order }) => {
      localStorage.setItem(
        "sidebar-project-workspace-order",
        JSON.stringify({
          version: 1,
          state: {
            projectOrder: [scope],
            pinnedWorkspaceOrder: [],
            workspaceOrderByProject: { [scope]: order },
          },
        }),
      );
    },
    { projectKey, workspaceKeys },
  );
  await reconnectSidebar(page);
}

test("Manual restores pre-beta order and keeps drag order across sorting and reloads", async ({
  page,
}) => {
  const seed = await seedWorkspace({ repoPrefix: "sidebar-manual-" });
  try {
    const second = await seed.client.createWorkspace({
      source: { kind: "directory", path: seed.repoPath, projectId: seed.projectId },
      title: "New manual workspace",
    });
    if (!second.workspace) throw new Error(second.error ?? "Workspace creation failed");
    const keys = [seed.workspaceId, second.workspace.id].map((id) => `${getServerId()}:${id}`);
    const ids = keys.map((key) => `sidebar-workspace-row-${key}`);
    const rows = page.locator(ids.map((id) => `[data-testid="${id}"]`).join(", "));
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await restorePreBetaOrder(page, projectEquivalenceViewKey(seed.projectKey), keys);
    await expect.poll(() => rowTestIds(rows)).toEqual(ids);
    await selectWorkspaceSort(page, "Created");
    await expect.poll(() => rowTestIds(rows)).toEqual([ids[1], ids[0]]);
    await selectWorkspaceSort(page, "Manual");
    await expect.poll(() => rowTestIds(rows)).toEqual(ids);
    await selectWorkspaceSort(page, "Created");
    await expect.poll(() => rowTestIds(rows)).toEqual([ids[1], ids[0]]);
    await selectWorkspaceSort(page, "Last prompt");
    await selectWorkspaceSort(page, "Manual");
    await expect.poll(() => rowTestIds(rows)).toEqual(ids);
    await quickDragFirstRowAfterSecond(rows, pressWorkspaceRow);
    await reconnectSidebar(page);
    await expect.poll(() => rowTestIds(rows)).toEqual([ids[1], ids[0]]);
    await quickDragFirstRowAfterSecond(rows, pressWorkspaceRow);
    await selectWorkspaceSort(page, "Created");
    await reconnectSidebar(page);
    await selectWorkspaceSort(page, "Manual");
    await expect.poll(() => rowTestIds(rows)).toEqual(ids);
  } finally {
    await seed.cleanup();
  }
});

function workspaceRows(page: Page, ids: string[]) {
  return page.locator(
    ids.map((id) => `[data-testid="sidebar-workspace-row-${getServerId()}:${id}"]`).join(", "),
  );
}

async function openWorkspaceRow(page: Page, workspaceId: string) {
  await page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspaceId}`).click();
  await expect(page).toHaveURL(new RegExp(`/workspace/${workspaceId}`));
}

test("collapsed groups lead with the open workspace instead of hiding it behind Show more", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await seedSevenWorkspaceScene(page, false);
  const { seed, ids } = await seedCompactProject();
  try {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await selectWorkspaceSort(page, "Created");
    const { rows, group } = compactProjectRows(page, seed);
    await expectWorkspaceOrder(rows, ids.slice(0, 7));
    await revealWorkspaces(group, "Show more");
    await openWorkspaceRow(page, ids[9]!);
    await expectWorkspaceOrder(rows, ids);
    await revealWorkspaces(group, "Show less");
    await expectWorkspaceOrder(rows, [...ids.slice(0, 7), ids[9]!]);
    await expect(
      page.getByTestId(`sidebar-workspace-row-${getServerId()}:${ids[9]!}`),
    ).toHaveAttribute("aria-selected", "true");
    await reconnectSidebar(page);
    await expectWorkspaceOrder(rows, [...ids.slice(0, 7), ids[9]!]);
    await expect(
      page.getByTestId(`sidebar-workspace-row-${getServerId()}:${ids[9]!}`),
    ).toHaveAttribute("aria-selected", "true");
    await openWorkspaceRow(page, ids[2]!);
    await expectWorkspaceOrder(rows, ids.slice(0, 7));
    await expect(
      page.getByTestId(`sidebar-workspace-row-${getServerId()}:${ids[2]!}`),
    ).toHaveAttribute("aria-selected", "true");
  } finally {
    await seed.cleanup();
  }
});

test("a Manual drag in a collapsed group keeps the open workspace's saved place", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const profiles = defaultSidebarModeProfiles();
  profiles.project.initialWorkspaceCount = 7;
  await page.addInitScript((modeProfiles) => {
    localStorage.setItem(
      "sidebar-view",
      JSON.stringify({
        version: 12,
        state: { groupMode: "project", workspaceSort: "manual", modeProfiles },
      }),
    );
  }, profiles);
  const { seed, ids } = await seedCompactProject();
  try {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    const projectKey = projectEquivalenceViewKey(seed.projectKey);
    await restorePreBetaOrder(
      page,
      projectKey,
      ids.map((id) => `${getServerId()}:${id}`),
    );
    await selectWorkspaceSort(page, "Manual");
    const rows = workspaceRows(page, ids);
    const toggle = page.getByTestId(`sidebar-project-show-more-${projectKey}`);
    await expectWorkspaceOrder(rows, ids.slice(0, 7));
    await toggle.click();
    await openWorkspaceRow(page, ids[9]!);
    await toggle.click();
    await expectWorkspaceOrder(rows, [...ids.slice(0, 7), ids[9]!]);
    await expect(
      page.getByTestId(`sidebar-workspace-row-${getServerId()}:${ids[9]!}`),
    ).toHaveAttribute("aria-selected", "true");
    await quickDragFirstRowAfterSecond(workspaceRows(page, [ids[0]!, ids[1]!]), pressWorkspaceRow);
    await expectWorkspaceOrder(rows, [ids[1]!, ids[0]!, ...ids.slice(2, 7), ids[9]!]);
    await reconnectSidebar(page);
    await expectWorkspaceOrder(rows, [ids[1]!, ids[0]!, ...ids.slice(2, 7), ids[9]!]);
    await toggle.click();
    await expectWorkspaceOrder(rows, [ids[1]!, ids[0]!, ...ids.slice(2)]);
  } finally {
    await seed.cleanup();
  }
});

async function finishSidebarDrag(page: Page): Promise<void> {
  await page.mouse.up();
  // dnd-kit's pointer sensor keeps its document click blocker for 50 ms after drop.
  // Row order updates before that blocker is removed; wait before the next user action.
  await page.waitForTimeout(60);
}

async function dragWithoutReordering(rows: Locator): Promise<void> {
  const before = await rowTestIds(rows);
  const source = await visibleBoundingBox(rows.nth(0));
  const target = await visibleBoundingBox(rows.nth(1));
  const page = rows.page();
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 5 });
  await finishSidebarDrag(page);
  await expect.poll(() => rowTestIds(rows)).toEqual(before);
}
