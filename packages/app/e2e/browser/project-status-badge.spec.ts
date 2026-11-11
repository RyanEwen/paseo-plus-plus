import { expect } from "@playwright/test";
import { test } from "../support/fixtures";
import { seedAppSettings } from "../support/helpers/app-settings";
import {
  expandStatusProject,
  expectCollapsedProjectStatus,
  expectProjectStatusHidden,
  expectWorkspaceStatus,
  openAndCollapseStatusProject,
  seedStatusProject,
  startNeedsInputWorkspace,
  startWorkingWorkspace,
} from "../helpers/project-status-badge";

test("a collapsed project surfaces its most urgent hidden workspace status", async ({ page }) => {
  test.setTimeout(120_000);
  await seedAppSettings(page, { paseoPlusPlus: { sidebarActivityChips: false } });
  const project = await seedStatusProject();

  try {
    await openAndCollapseStatusProject(page, project);
    await expectProjectStatusHidden(page, project);

    await startWorkingWorkspace(project);
    await expectCollapsedProjectStatus(page, project, "Working");

    await startNeedsInputWorkspace(project);
    await expectCollapsedProjectStatus(page, project, "Needs input");

    await expandStatusProject(page, project);
    await expectProjectStatusHidden(page, project);
    await expectWorkspaceStatus(page, "Working workspace", "running");
    await expectWorkspaceStatus(page, "Needs input workspace", "needs_input");
  } finally {
    await project.seed.cleanup().catch(() => undefined);
  }
});

test("a project activity chip announces the most urgent workspace status once", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await seedAppSettings(page, { paseoPlusPlus: { sidebarActivityChips: true } });
  const project = await seedStatusProject();
  const projectRow = page.getByTestId(`sidebar-project-row-${project.seed.projectKey}`);
  const aggregateStatus = projectRow.getByRole("status");

  try {
    await openAndCollapseStatusProject(page, project);
    await expect(projectRow.getByRole("status", { name: "Done", exact: true })).toBeVisible();
    await expect(aggregateStatus).toHaveCount(1);

    await startWorkingWorkspace(project);
    await expectCollapsedProjectStatus(page, project, "Working");
    await expect(aggregateStatus).toHaveCount(1);

    // The project still has a working workspace; the urgent aggregate replaces Working.
    await startNeedsInputWorkspace(project);
    await expectCollapsedProjectStatus(page, project, "Needs input");
    await expect(aggregateStatus).toHaveCount(1);
    await expect(projectRow.getByRole("status", { name: "Working", exact: true })).toHaveCount(0);

    // Unlike the collapsed-only glyph, the chip stays when the project expands.
    await expandStatusProject(page, project);
    await expect(
      projectRow.getByRole("status", { name: "Needs input", exact: true }),
    ).toBeVisible();
    await expect(aggregateStatus).toHaveCount(1);
    await expect(projectRow.getByRole("status", { name: "Working", exact: true })).toHaveCount(0);
    await expectWorkspaceStatus(page, "Working workspace", "running");
    await expectWorkspaceStatus(page, "Needs input workspace", "needs_input");
  } finally {
    await project.seed.cleanup().catch(() => undefined);
  }
});
