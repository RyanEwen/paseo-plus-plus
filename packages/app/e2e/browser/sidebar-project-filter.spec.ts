import {
  seedStatusProject,
  startWorkingWorkspace,
  startNeedsInputWorkspace,
} from "../helpers/project-status-badge";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Page, type Locator } from "@playwright/test";
import { test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedAppSettings } from "../support/helpers/app-settings";
import {
  connectSeedClient,
  seedOverflowingProjects,
  seedWorkspace,
} from "../support/helpers/seed-client";
import {
  addProjectFlowInput,
  chooseAddProjectMethod,
  expectAddProjectPage,
  openAddProjectFlow,
} from "../support/helpers/add-project-flow";
import { expectOpenedProject } from "../support/helpers/project-picker-ui";
import { getServerId } from "../support/helpers/server-id";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";
import {
  closeSidebarDisplayPreferences,
  openSidebarDisplayPage,
  openSidebarProjectFilter,
  pinWorkspaceFromSidebar,
  openMobileAgentSidebar,
  selectAllProjectsFilter,
  selectSidebarStatusGrouping,
  selectSidebarProjectGrouping,
  toggleProjectFilter,
} from "../support/helpers/sidebar";

/** Read the durable allowlist, including keys for currently unavailable projects. */
async function readStoredProjectFilters(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem("sidebar-view") ?? "{}").state;
    return state.localModeFilters[state.groupMode].projectFilters;
  });
}

/** Walk the production menu's registered order; pre-existing cached projects may precede the seed. */
async function arrowDownToMenuItem(page: Page, surface: Locator, target: Locator): Promise<void> {
  // The chooser opens from cached metadata before its host inventory has necessarily arrived.
  await expect(target).toBeVisible();
  const itemCount = await surface
    .locator('[data-menu-item="true"]:not([data-menu-disabled="true"])')
    .count();
  for (let step = 0; step < itemCount; step++) {
    await page.keyboard.press("ArrowDown");
    if (await target.evaluate((node) => node === document.activeElement)) return;
  }
  await expect(target).toBeFocused();
}

/** Pick a display option through the same menu on desktop and compact layouts. */
async function selectDisplayOption(page: Page, section: string, option: string): Promise<void> {
  await openSidebarDisplayPage(page, `sidebar-display-${section}`);
  await page.getByTestId(option).click();
  await closeSidebarDisplayPreferences(page);
}

/** Open the app at the compact (phone) or desktop size with the workspace sidebar showing. */
async function openSidebarAt(page: Page, compact: boolean): Promise<void> {
  if (compact) await page.setViewportSize({ width: 390, height: 844 });
  await gotoAppShell(page);
  if (compact) await openMobileAgentSidebar(page);
}

/** The chooser's open surface: the bottom sheet's content on compact, the popover on desktop. */
function selectorSurface(page: Page, compact: boolean): Locator {
  return page.getByTestId(
    compact ? "sidebar-project-selector-content-content" : "sidebar-project-selector-content",
  );
}

/** Read the actual scroll owner so a stationary list cannot satisfy the geometry case. */
async function readScrollTop(scroll: Locator): Promise<number> {
  return scroll.evaluate((element) => element.scrollTop);
}

/** Scroll a list's scroll owner to its end. */
async function scrollToEnd(scroll: Locator): Promise<void> {
  await scroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
}

/** Read a locator's rendered bounds, failing the test when it has none. */
async function requireBox(locator: Locator, name: string) {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`${name} has no rendered bounds`);
  return box;
}

/** The vertical positions of the heading's project selector and display menu trigger. */
async function readHeadingGeometry(page: Page): Promise<{ selectorY: number; displayY: number }> {
  const selector = await requireBox(page.getByTestId("sidebar-project-selector"), "Selector");
  const display = await requireBox(
    page.getByTestId("sidebar-display-preferences-menu"),
    "Display menu",
  );
  return { selectorY: selector.y, displayY: display.y };
}

/** Remove a project the test created through Add Project. */
async function removeAddedProject(projectId: string): Promise<void> {
  const client = await connectSeedClient();
  try {
    await client.removeProject(projectId);
  } finally {
    await client.close();
  }
}

test.describe("Sidebar project filter", () => {
  test.describe.configure({ timeout: 180_000 });
  test("filters independently of grouping and keeps empty projects reachable in status mode", async ({
    page,
  }, testInfo) => {
    const occupied = await seedWorkspace({ repoPrefix: "display-occupied-", title: "Active work" });
    const empty = await seedWorkspace({ repoPrefix: "display-empty-", title: "Archived work" });
    const serverId = getServerId();
    const emptyProjectRow = page.getByTestId(`sidebar-project-row-${empty.projectKey}`);
    const occupiedRow = page.getByTestId(
      `sidebar-workspace-row-${serverId}:${occupied.workspaceId}`,
    );
    try {
      const archived = await empty.client.archiveWorkspace(empty.workspaceId);
      expect(archived.error).toBeNull();
      await gotoAppShell(page);
      await expect(occupiedRow).toBeVisible({ timeout: 30_000 });
      await expect(emptyProjectRow).toBeVisible();

      await selectDisplayOption(page, "empty-workspaces", "sidebar-empty-workspaces-group");
      await expect(page.getByTestId("sidebar-empty-project-group")).toBeVisible();
      await selectDisplayOption(page, "empty-workspaces", "sidebar-empty-workspaces-show");
      await expect(page.getByTestId("sidebar-empty-project-group")).toHaveCount(0);
      await expect(emptyProjectRow).toBeVisible();
      await selectDisplayOption(page, "empty-workspaces", "sidebar-empty-workspaces-hide");
      await expect(emptyProjectRow).toHaveCount(0);
      await expect(occupiedRow).toBeVisible();
      await selectSidebarStatusGrouping(page);
      await selectDisplayOption(page, "empty-workspaces", "sidebar-empty-workspaces-group");
      await expect(emptyProjectRow).toBeVisible();
      await page.getByTestId("sidebar-status-group-no-unarchived-workspaces").click();
      await expect(emptyProjectRow).toHaveCount(0);
      await page.getByTestId("sidebar-status-group-no-unarchived-workspaces").click();
      await expect(emptyProjectRow).toBeVisible();
      await selectDisplayOption(page, "empty-workspaces", "sidebar-empty-workspaces-show");
      await page.reload();
      await expect(emptyProjectRow).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("sidebar-empty-project-group")).toHaveCount(0);
      await selectSidebarProjectGrouping(page);
      await expect(emptyProjectRow).toHaveCount(0);
      await selectDisplayOption(page, "empty-workspaces", "sidebar-empty-workspaces-show");
      await selectDisplayOption(page, "sorting", "sidebar-sorting-project");
      await page.reload();
      await expect(emptyProjectRow).toBeVisible({ timeout: 30_000 });
      await page.getByTestId("sidebar-display-preferences-menu").click();
      await expect(page.getByTestId("sidebar-display-sorting")).toContainText("Project name");
      await expect(page.getByTestId("sidebar-display-empty-workspaces")).toContainText("Show");
      await page.screenshot({ path: testInfo.outputPath("sidebar-empty-project-group.png") });
      await closeSidebarDisplayPreferences(page);
    } finally {
      await empty.cleanup();
      await occupied.cleanup();
    }
  });

  test("persists independent project filters in both grouping modes", async ({ page }) => {
    // Independent projects make each mode’s local allowlist observable.
    const alpha = await seedWorkspace({ repoPrefix: "project-filter-alpha-", title: "Alpha work" });
    const beta = await seedWorkspace({ repoPrefix: "project-filter-beta-", title: "Beta work" });
    const serverId = getServerId();
    const alphaRow = page.getByTestId(`sidebar-workspace-row-${serverId}:${alpha.workspaceId}`);
    const betaRow = page.getByTestId(`sidebar-workspace-row-${serverId}:${beta.workspaceId}`);

    try {
      await gotoAppShell(page);
      await expect(alphaRow).toBeVisible({ timeout: 30_000 });
      await expect(betaRow).toBeVisible({ timeout: 30_000 });

      // Project filtering lives in the heading chooser, not the Display menu.
      await page.getByTestId("sidebar-display-preferences-menu").click();
      await expect(page.getByTestId("sidebar-display-show")).toBeVisible();
      await expect(page.getByTestId("sidebar-display-project-filter")).toHaveCount(0);
      await closeSidebarDisplayPreferences(page);

      await openSidebarProjectFilter(page);
      await expect(page.getByTestId("sidebar-project-selector-all")).toBeVisible();
      await toggleProjectFilter(page, alpha.projectKey);
      await closeSidebarDisplayPreferences(page);

      await expect(alphaRow).toBeVisible();
      await expect(betaRow).toHaveCount(0, { timeout: 10_000 });

      await expect(page.getByTestId("sidebar-project-selector")).toHaveText(
        `${alpha.projectDisplayName} Workspaces`,
      );
      await selectSidebarStatusGrouping(page);
      await expect(alphaRow).toBeVisible({ timeout: 15_000 });
      await expect(betaRow).toBeVisible();
      await openSidebarProjectFilter(page);
      await toggleProjectFilter(page, beta.projectKey);
      await closeSidebarDisplayPreferences(page);
      await expect(alphaRow).toHaveCount(0);
      await expect(betaRow).toBeVisible();
      await selectSidebarProjectGrouping(page);
      await expect(alphaRow).toBeVisible();
      await expect(betaRow).toHaveCount(0);
      // The filter is view state and survives a cold load.
      await page.reload();
      await expect(alphaRow).toBeVisible({ timeout: 30_000 });
      await expect(betaRow).toHaveCount(0);
      await selectSidebarStatusGrouping(page);
      await expect(alphaRow).toHaveCount(0);
      await expect(betaRow).toBeVisible();
      await page.reload();
      await expect(betaRow).toBeVisible({ timeout: 30_000 });
      await expect(alphaRow).toHaveCount(0);
      await selectSidebarProjectGrouping(page);
      await expect(alphaRow).toBeVisible();
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

  test("lists the only project without a Hosts branch on one host", async ({ page }) => {
    const only = await seedWorkspace({ repoPrefix: "project-filter-solo-", title: "Solo work" });
    const serverId = getServerId();

    try {
      await gotoAppShell(page);
      await expect(
        page.getByTestId(`sidebar-workspace-row-${serverId}:${only.workspaceId}`),
      ).toBeVisible({ timeout: 30_000 });

      await expect(page.getByTestId("sidebar-project-selector")).toHaveText("All Workspaces");
      await openSidebarProjectFilter(page);
      await expect(page.getByTestId("sidebar-chooser-hosts")).toHaveCount(0);
      await expect(
        page.getByTestId(`sidebar-project-selector-root-${only.projectKey}`),
      ).toBeVisible();
    } finally {
      await only.cleanup();
    }
  });
});

test.describe("Sidebar project selector", () => {
  test.describe.configure({ timeout: 180_000 });

  test("the chooser label shares the Pinned heading's rail", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "selector-rail-", title: "Rail work" });
    try {
      await gotoAppShell(page);
      await expect(
        page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspace.workspaceId}`),
      ).toBeVisible({ timeout: 30_000 });
      await pinWorkspaceFromSidebar(page, workspace.workspaceId);

      // Both headings sit in the same list, so their labels must start at the same x.
      const pinnedLabel = page
        .getByTestId("sidebar-pinned-section-header")
        .getByText("Pinned", { exact: true });
      const chooserLabel = page
        .getByTestId("sidebar-project-selector")
        .getByText("All Workspaces", { exact: true });
      await expect(pinnedLabel).toBeVisible();
      await expect(chooserLabel).toBeVisible();
      const [pinned, chooser] = await Promise.all([
        pinnedLabel.boundingBox(),
        chooserLabel.boundingBox(),
      ]);
      if (!pinned || !chooser) throw new Error("Section headings have no rendered bounds");
      expect(chooser.x).toBeCloseTo(pinned.x, 0);
    } finally {
      await workspace.cleanup();
    }
  });

  for (const compact of [false, true]) {
    test(`workspace controls stay anchored while the list scrolls on ${compact ? "compact" : "desktop"}`, async ({
      page,
    }, testInfo) => {
      // Enough rows to overflow the phone-height sidebar that openSidebarAt opens.
      const seeded = await seedOverflowingProjects({
        count: 16,
        repoPrefix: "sticky-header-",
        titlePrefix: "Scroll workspace",
      });
      const { projects } = seeded;
      try {
        await openSidebarAt(page, compact);
        await waitForSidebarHydration(page);

        const selector = page.getByTestId("sidebar-project-selector");
        const display = page.getByTestId("sidebar-display-preferences-menu");
        const scroll = page.getByTestId("sidebar-project-workspace-list-scroll");
        const firstProject = page.getByTestId(`sidebar-project-row-${projects[0].projectKey}`);
        await expect(selector).toHaveText("All Workspaces");
        await expect(firstProject).toBeVisible();
        const headingBefore = await readHeadingGeometry(page);
        const projectBefore = await requireBox(firstProject, "First project row");

        // Scroll, then expect the rows to have moved and the heading to be where it was.
        await scrollToEnd(scroll);
        await expect.poll(() => readScrollTop(scroll)).toBeGreaterThan(150);
        await expect
          .poll(async () => (await firstProject.boundingBox())?.y ?? Infinity)
          .toBeLessThan(projectBefore.y - 150);
        await expect(selector).toBeInViewport();
        await expect(display).toBeInViewport();
        const headingAfter = await readHeadingGeometry(page);
        expect(headingAfter.selectorY).toBeCloseTo(headingBefore.selectorY, 0);
        expect(headingAfter.displayY).toBeCloseTo(headingBefore.displayY, 0);
        await page.screenshot({
          path: testInfo.outputPath(
            `sticky-workspace-header-${compact ? "compact" : "desktop"}.png`,
          ),
        });
        await display.click();
        await expect(page.getByTestId("sidebar-display-workspace-list")).toBeVisible();
        await closeSidebarDisplayPreferences(page);
        await selector.click();
        await page
          .getByTestId(`sidebar-project-selector-root-${projects[0].projectKey}-checkbox`)
          .click();
        await expect.poll(() => readStoredProjectFilters(page)).toEqual([projects[0].projectKey]);
      } finally {
        await seeded.cleanup();
      }
    });
  }

  for (const compact of [false, true]) {
    test(`preserves multi-selection and filters pinned workspaces on ${compact ? "compact" : "desktop"}`, async ({
      page,
    }, testInfo) => {
      const alpha = await seedWorkspace({ repoPrefix: "selector-alpha-", title: "Alpha work" });
      const beta = await seedWorkspace({ repoPrefix: "selector-beta-", title: "Beta work" });
      const serverId = getServerId();
      const alphaRow = page.getByTestId(`sidebar-workspace-row-${serverId}:${alpha.workspaceId}`);
      const betaRow = page.getByTestId(`sidebar-workspace-row-${serverId}:${beta.workspaceId}`);
      const trigger = page.getByTestId("sidebar-project-selector");
      const surface = selectorSurface(page, compact);
      try {
        await openSidebarAt(page, compact);
        await expect(trigger).toHaveText("All Workspaces");
        await pinWorkspaceFromSidebar(page, beta.workspaceId);
        await trigger.click();
        await page
          .getByTestId(`sidebar-project-selector-root-${alpha.projectKey}-checkbox`)
          .click();
        await expect(surface).toBeVisible();
        await expect(alphaRow).toBeVisible();
        await expect(betaRow).toHaveCount(0);
        await expect(trigger).toContainText("Workspaces");
        // The catalog stays complete after selecting one project.
        await expect(
          page.getByTestId(`sidebar-project-selector-root-${beta.projectKey}`),
        ).toBeVisible();
        await page.getByTestId(`sidebar-project-selector-root-${beta.projectKey}-checkbox`).click();
        await expect(trigger).toHaveText("2 Projects’ Workspaces");
        await expect(betaRow).toBeVisible();
        await closeSidebarDisplayPreferences(page);
        if (!compact) await expect(trigger).toBeFocused();
        await expect(surface).toHaveCount(0);
        await page.reload();
        if (compact) await openMobileAgentSidebar(page);
        await expect(trigger).toHaveText("2 Projects’ Workspaces");
        await page.getByTestId("sidebar-display-preferences-menu").click();
        await expect(page.getByTestId("sidebar-display-project-filter")).toHaveCount(0);
        await expect(page.getByTestId("sidebar-display-show")).toBeVisible();
        await closeSidebarDisplayPreferences(page);
        await selectSidebarStatusGrouping(page);
        await expect(alphaRow).toBeVisible();
        await expect(betaRow).toBeVisible();
        await trigger.click();
        await page
          .getByTestId(`sidebar-project-selector-root-${alpha.projectKey}-checkbox`)
          .click();
        await expect(betaRow).toHaveCount(0);
        await page.getByTestId("sidebar-project-selector-all").click();
        await expect(trigger).toHaveText("All Workspaces");
        await expect(betaRow).toBeVisible();
        await expect(surface).toHaveCount(0);
        await trigger.click();
        await page.screenshot({
          path: testInfo.outputPath(`selector-${compact ? "compact" : "desktop"}.png`),
        });
      } finally {
        await beta.cleanup();
        await alpha.cleanup();
      }
    });
  }

  for (const compact of [false, true]) {
    test(`project names select only and close, checkboxes stay independent on ${compact ? "compact" : "desktop"}`, async ({
      page,
    }, testInfo) => {
      const alpha = await seedWorkspace({
        repoPrefix: "selector-single-alpha-",
        title: "Alpha work",
      });
      const beta = await seedWorkspace({ repoPrefix: "selector-single-beta-", title: "Beta work" });
      const trigger = page.getByTestId("sidebar-project-selector");
      const surface = selectorSurface(page, compact);
      const alphaName = page.getByTestId(`sidebar-project-selector-root-${alpha.projectKey}`);
      const betaName = page.getByTestId(`sidebar-project-selector-root-${beta.projectKey}`);
      const alphaCheckbox = page.getByTestId(
        `sidebar-project-selector-root-${alpha.projectKey}-checkbox`,
      );
      const betaCheckbox = page.getByTestId(
        `sidebar-project-selector-root-${beta.projectKey}-checkbox`,
      );
      try {
        await openSidebarAt(page, compact);
        await trigger.click();
        await expect(alphaCheckbox).toHaveRole("checkbox");
        await expect(alphaCheckbox).toHaveAccessibleName(/Include selector-single-alpha-/);
        await expect(alphaName).toHaveAccessibleName(/Show only selector-single-alpha-/);
        await alphaCheckbox.click();
        await betaCheckbox.click();
        await expect(surface).toBeVisible();
        await expect(trigger).toHaveText("2 Projects’ Workspaces");
        await betaName.click();
        await expect(surface).toHaveCount(0, { timeout: 2000 });
        await expect(trigger).toHaveText(`${beta.projectDisplayName} Workspaces`);
        if (!compact) await expect(trigger).toBeFocused();
        await trigger.click();
        await expect(betaCheckbox).toBeChecked();
        await expect(alphaCheckbox).not.toBeChecked();
        await alphaCheckbox.click();
        await expect(surface).toBeVisible();
        await expect(alphaCheckbox).toBeChecked();
        await expect(betaCheckbox).toBeChecked();
        await expect(trigger).toHaveText("2 Projects’ Workspaces");
        await page.screenshot({
          path: testInfo.outputPath(`split-selection-${compact ? "compact" : "desktop"}.png`),
        });
        await alphaName.click();
        await expect(surface).toHaveCount(0, { timeout: 2000 });
        await expect(trigger).toHaveText(`${alpha.projectDisplayName} Workspaces`);
        await trigger.click();
        await page.getByTestId("sidebar-project-selector-all").click();
        await expect(surface).toHaveCount(0, { timeout: 2000 });
        await expect(trigger).toHaveText("All Workspaces");
      } finally {
        await beta.cleanup();
        await alpha.cleanup();
      }
    });
  }

  test("a project added while one project is selected joins the selection", async ({ page }) => {
    const alpha = await seedWorkspace({ repoPrefix: "selector-added-alpha-", title: "Alpha work" });
    const parentDirectory = await mkdtemp(path.join(tmpdir(), "paseo-e2e-selector-added-"));
    const directoryName = `added-${randomUUID().slice(0, 8)}`;
    const trigger = page.getByTestId("sidebar-project-selector");
    let addedProjectId: string | null = null;
    try {
      await gotoAppShell(page);
      await trigger.click();
      await page.getByTestId(`sidebar-project-selector-root-${alpha.projectKey}`).click();
      await expect(trigger).toHaveText(`${alpha.projectDisplayName} Workspaces`);

      // Create an empty directory as a new project through the Add Project flow.
      await openAddProjectFlow(page);
      await chooseAddProjectMethod(page, "new-directory");
      await addProjectFlowInput(page).fill(parentDirectory);
      await page.keyboard.press("Enter");
      await expectAddProjectPage(page, "new-directory-name");
      await page.keyboard.type(directoryName);
      await page.keyboard.press("Enter");
      addedProjectId = await expectOpenedProject(page, directoryName);

      // The selection keeps the earlier project and adds the new one.
      await expect(trigger).toHaveText("2 Projects’ Workspaces");
      await trigger.click();
      await expect(
        page.getByRole("checkbox", { name: `Include ${directoryName}`, exact: true }),
      ).toBeChecked();
      await expect(
        page.getByTestId(`sidebar-project-selector-root-${alpha.projectKey}-checkbox`),
      ).toBeChecked();
      await closeSidebarDisplayPreferences(page);
    } finally {
      if (addedProjectId) await removeAddedProject(addedProjectId);
      await rm(parentDirectory, { recursive: true, force: true });
      await alpha.cleanup();
    }
  });

  test("keyboard distinguishes choosing a name from toggling its checkbox", async ({
    page,
  }, testInfo) => {
    const alpha = await seedWorkspace({ repoPrefix: "selector-keyboard-alpha-" });
    const trigger = page.getByTestId("sidebar-project-selector");
    const surface = page.getByTestId("sidebar-project-selector-content");
    const name = page.getByTestId(`sidebar-project-selector-root-${alpha.projectKey}`);
    const checkbox = page.getByTestId(`sidebar-project-selector-root-${alpha.projectKey}-checkbox`);
    try {
      await gotoAppShell(page);
      await trigger.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("sidebar-project-selector-all")).toBeFocused();
      await arrowDownToMenuItem(page, surface, name);
      await expect(name).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(surface).toHaveCount(0, { timeout: 2000 });
      await expect(trigger).toBeFocused();
      await expect(trigger).toHaveText(`${alpha.projectDisplayName} Workspaces`);
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("sidebar-project-selector-all")).toBeFocused();
      await arrowDownToMenuItem(page, surface, name);
      await expect(name).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(checkbox).toBeFocused();
      await page.screenshot({ path: testInfo.outputPath("split-checkbox-keyboard-focus.png") });
      await page.keyboard.press("Space");
      await expect(checkbox).not.toBeChecked();
      await expect(checkbox).toBeFocused();
      await expect(surface).toBeVisible();
      await expect(trigger).toHaveText("All Workspaces");
      await page.keyboard.press("Enter");
      await expect(checkbox).toBeChecked();
      await expect(surface).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
    } finally {
      await alpha.cleanup();
    }
  });

  test("keeps saved multi-project and offline keys across a reload", async ({ page }) => {
    const alpha = await seedWorkspace({ repoPrefix: "selector-saved-alpha-" });
    const beta = await seedWorkspace({ repoPrefix: "selector-saved-beta-" });
    const savedFilters = [alpha.projectKey, beta.projectKey, "offline-project"];
    try {
      await page.addInitScript((projectFilters) => {
        if (!localStorage.getItem("sidebar-view")) {
          localStorage.setItem(
            "sidebar-view",
            JSON.stringify({ version: 11, state: { projectFilters } }),
          );
        }
      }, savedFilters);
      await gotoAppShell(page);
      const trigger = page.getByTestId("sidebar-project-selector");
      await expect(trigger).toHaveText("2 Projects’ Workspaces");
      await trigger.click();
      await page.getByTestId(`sidebar-project-selector-root-${alpha.projectKey}-checkbox`).click();
      await expect(page.getByTestId("sidebar-project-selector-content")).toBeVisible();
      await expect
        .poll(() => readStoredProjectFilters(page))
        .toEqual([beta.projectKey, "offline-project"]);
      await page.getByTestId(`sidebar-project-selector-root-${alpha.projectKey}-checkbox`).click();
      await page.keyboard.press("Escape");
      const toggledFilters = [beta.projectKey, "offline-project", alpha.projectKey];
      await expect.poll(() => readStoredProjectFilters(page)).toEqual(toggledFilters);
      await page.reload();
      await expect(trigger).toHaveText("2 Projects’ Workspaces");
      await openSidebarProjectFilter(page);
      await expect(
        page.getByTestId(`sidebar-project-selector-root-${alpha.projectKey}-checkbox`),
      ).toHaveAttribute("aria-checked", "true");
      await expect(
        page.getByTestId(`sidebar-project-selector-root-${beta.projectKey}-checkbox`),
      ).toHaveAttribute("aria-checked", "true");
      await closeSidebarDisplayPreferences(page);
      await expect.poll(() => readStoredProjectFilters(page)).toEqual(toggledFilters);
    } finally {
      await beta.cleanup();
      await alpha.cleanup();
    }
  });
});

test.describe("Sidebar project selector activity", () => {
  test.describe.configure({ timeout: 180_000 });

  for (const compact of [false, true]) {
    test(`live badges include unselected projects and respect the activity opt-out on ${compact ? "compact" : "desktop"}`, async ({
      page,
    }, testInfo) => {
      const busy = await seedStatusProject();
      const quiet = await seedWorkspace({ repoPrefix: "selector-quiet-", title: "Quiet work" });
      const trigger = page.getByTestId("sidebar-project-selector");
      const surface = selectorSurface(page, compact);
      const busyChoice = page.getByTestId(`sidebar-project-selector-root-${busy.seed.projectKey}`);
      const quietChoice = page.getByTestId(`sidebar-project-selector-root-${quiet.projectKey}`);
      const busyChip = page.getByTestId(
        `sidebar-project-selector-root-${busy.seed.projectKey}-activity`,
      );
      const quietChip = page.getByTestId(
        `sidebar-project-selector-root-${quiet.projectKey}-activity`,
      );
      try {
        await openSidebarAt(page, compact);
        await waitForSidebarHydration(page);
        await pinWorkspaceFromSidebar(page, busy.seed.workspaceId);
        await trigger.click();
        await expect(busyChip).toHaveText("Done");
        await expect(quietChip).toHaveText("Done");
        await expect(
          page.getByTestId("sidebar-project-selector-all").getByRole("status"),
        ).toHaveCount(0);
        await startWorkingWorkspace(busy);
        await expect(busyChip).toHaveText("Working");
        await busy.seed.client.createAgent({
          provider: "mock",
          cwd: busy.seed.repoPath,
          workspaceId: busy.needsInputWorkspaceId,
          title: "Second worker",
          modeId: "load-test",
          model: "thirty-minute-stream",
          initialPrompt: "keep streaming for the test",
        });
        await expect(busyChip).toHaveText("2 working");
        await expect(page.getByTestId(`sidebar-project-status-${busy.seed.projectKey}`)).toHaveText(
          "2 working",
        );
        // A different selected project must not remove the busy choice's activity subscription.
        await quietChoice.click();
        await expect(surface).toHaveCount(0);
        await trigger.click();
        await expect(busyChip).toHaveText("2 working");
        await page
          .getByTestId(`sidebar-project-selector-root-${busy.seed.projectKey}-checkbox`)
          .click();
        await expect(surface).toBeVisible();
        await expect(busyChip).toHaveText("2 working");
        await page.screenshot({
          path: testInfo.outputPath(
            `selector-activity-working-${compact ? "compact" : "desktop"}.png`,
          ),
        });
        await page
          .getByTestId(`sidebar-project-selector-root-${busy.seed.projectKey}-checkbox`)
          .click();
        await expect(trigger).toHaveText(`${quiet.projectDisplayName} Workspaces`);
        // This live priority change happens while the busy project's sidebar rows are filtered out.
        const approval = await busy.seed.client.createWorkspace({
          source: { kind: "directory", path: busy.seed.repoPath, projectId: busy.seed.projectId },
          title: "Approval work",
        });
        if (!approval.workspace) throw new Error(approval.error ?? "Approval workspace missing");
        await startNeedsInputWorkspace({ ...busy, needsInputWorkspaceId: approval.workspace.id });
        await expect(busyChip).toHaveText("Needs input");
        await expect(quietChip).toHaveText("Done");
        await expect(
          page.getByTestId(`sidebar-project-selector-root-${busy.seed.projectKey}-working-spinner`),
        ).toHaveCount(0);
        await page.screenshot({
          path: testInfo.outputPath(
            `selector-activity-input-${compact ? "compact" : "desktop"}.png`,
          ),
        });
        await closeSidebarDisplayPreferences(page);
        await seedAppSettings(page, { paseoPlusPlus: { sidebarActivityChips: false } });
        await page.reload();
        if (compact) await openMobileAgentSidebar(page);
        await trigger.click();
        await expect(busyChip).toHaveCount(0);
        await expect(quietChip).toHaveCount(0);
        await expect(
          page.getByTestId(`sidebar-project-status-${busy.seed.projectKey}`),
        ).toHaveCount(0);
        await busyChoice.click();
        await expect(surface).toHaveCount(0);
        await expect(trigger).toHaveText(`${busy.seed.projectDisplayName} Workspaces`);
        await expect(
          page.getByTestId(`sidebar-project-status-${busy.seed.projectKey}`),
        ).toHaveCount(0);
        await trigger.click();
        await page
          .getByTestId(`sidebar-project-selector-root-${quiet.projectKey}-checkbox`)
          .click();
        await expect(surface).toBeVisible();
        await expect(trigger).toHaveText("2 Projects’ Workspaces");
        await expect(busyChip).toHaveCount(0);
      } finally {
        await quiet.cleanup();
        await busy.seed.cleanup();
      }
    });
  }
});
