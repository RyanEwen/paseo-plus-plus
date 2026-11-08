import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { gotoWorkspace } from "../support/helpers/launcher";
import { getServerId } from "../support/helpers/server-id";
import { seedWorkspace } from "../support/helpers/seed-client";
import {
  closeSidebarDisplayPreferences,
  openSidebarDisplayPage,
  selectSidebarProjectGrouping,
} from "../support/helpers/sidebar";
import {
  pressSidebarWorkspaceRow,
  quickDragFirstSidebarRowAfterSecond,
  sidebarRowTestIds,
} from "../support/helpers/sidebar-drag";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

type SeededWorkspace = Awaited<ReturnType<typeof seedWorkspace>>;
type SeedClient = SeededWorkspace["client"];

interface FamilyScene {
  seed: SeededWorkspace;
  /** Workspace IDs: a parent with two child workspaces, plus an independent root. */
  parent: string;
  childA: string;
  childB: string;
  independent: string;
}

/** Run one mock agent to completion and read its completion, leaving the workspace Done. */
async function finishAgent(
  client: SeedClient,
  input: { workspaceId: string; cwd: string; callerAgentId?: string },
): Promise<string> {
  const agent = await client.createAgent({
    provider: "mock",
    cwd: input.cwd,
    workspaceId: input.workspaceId,
    modeId: "load-test",
    model: "e2e-fast-stream",
    initialPrompt: "Finish.",
    ...(input.callerAgentId ? { callerAgentId: input.callerAgentId } : {}),
  });
  await client.waitForFinish(agent.id, 20_000);
  await client.clearWorkspaceAttention(input.workspaceId);
  return agent.id;
}

/** Create a workspace in the seeded project and finish one agent in it, under a caller if given. */
async function seedProjectWorkspace(
  seed: SeededWorkspace,
  title: string,
  callerAgentId?: string,
): Promise<string> {
  const created = await seed.client.createWorkspace({
    source: { kind: "directory", path: seed.repoPath, projectId: seed.projectId },
    title,
  });
  if (!created.workspace) throw new Error(created.error ?? `No ${title} workspace`);
  await finishAgent(seed.client, {
    workspaceId: created.workspace.id,
    cwd: seed.repoPath,
    callerAgentId,
  });
  return created.workspace.id;
}

/**
 * A project whose parent workspace's agent created two child workspaces' agents. Parentage comes
 * only from those agent relationships; the independent root has its own agent.
 */
async function seedFamilyScene(prefix: string): Promise<FamilyScene> {
  const seed = await seedWorkspace({ repoPrefix: prefix, title: "Parent" });
  try {
    const parentAgent = await finishAgent(seed.client, {
      workspaceId: seed.workspaceId,
      cwd: seed.repoPath,
    });
    const childA = await seedProjectWorkspace(seed, "Child A", parentAgent);
    const childB = await seedProjectWorkspace(seed, "Child B", parentAgent);
    const independent = await seedProjectWorkspace(seed, "Independent");
    return { seed, parent: seed.workspaceId, childA, childB, independent };
  } catch (error) {
    await seed.cleanup();
    throw error;
  }
}

function key(workspaceId: string): string {
  return `${getServerId()}:${workspaceId}`;
}

function workspaceRow(page: Page, workspaceId: string): Locator {
  return page.getByTestId(`sidebar-workspace-row-${key(workspaceId)}`);
}

function disclosure(page: Page, workspaceId: string): Locator {
  return page.getByTestId(`sidebar-workspace-children-toggle-${key(workspaceId)}`);
}

function childrenSummary(page: Page, workspaceId: string): Locator {
  return page.getByTestId(`sidebar-workspace-children-summary-${key(workspaceId)}`);
}

/** Rows matched by workspace ID, in DOM order. */
function rowsOf(page: Page, workspaceIds: readonly string[]): Locator {
  return page.locator(
    workspaceIds.map((id) => `[data-testid="sidebar-workspace-row-${key(id)}"]`).join(", "),
  );
}

/** Open the app in Project view with Custom workspace sorting, so drags are enabled. */
async function openProjectViewWithCustomSort(page: Page): Promise<void> {
  await gotoAppShell(page);
  await waitForSidebarHydration(page);
  await selectSidebarProjectGrouping(page);
  await openSidebarDisplayPage(page, "sidebar-display-sorting");
  await page.getByTestId("sidebar-sorting-custom").click();
  await closeSidebarDisplayPreferences(page);
}

async function contentIndent(page: Page, workspaceId: string): Promise<string> {
  return page
    .getByTestId(`sidebar-workspace-content-${key(workspaceId)}`)
    .evaluate((node) => getComputedStyle(node).paddingLeft);
}

test.describe("Sidebar workspace families", () => {
  let scene: FamilyScene;

  test.beforeEach(async () => {
    scene = await seedFamilyScene("sidebar-families-");
  });

  test.afterEach(async () => {
    await scene.seed.cleanup();
  });

  test("child workspaces sit beneath their parent with an indented content rail", async ({
    page,
  }) => {
    await openProjectViewWithCustomSort(page);
    const family = page.getByTestId(`sidebar-workspace-family-${key(scene.parent)}`);
    await expect(family.locator('[data-testid^="sidebar-workspace-row-"]')).toHaveCount(3);
    await expect(disclosure(page, scene.parent)).toHaveAttribute("aria-expanded", "true");
    expect(await contentIndent(page, scene.parent)).toBe("0px");
    expect(await contentIndent(page, scene.childA)).toBe("12px");
    expect(await contentIndent(page, scene.independent)).toBe("0px");
    await expect(disclosure(page, scene.independent)).toHaveCount(0);
  });

  test("collapsing a family describes its children on the parent and survives a reload", async ({
    page,
  }) => {
    await openProjectViewWithCustomSort(page);
    await disclosure(page, scene.parent).click();
    await expect(disclosure(page, scene.parent)).toHaveAttribute("aria-expanded", "false");
    await expect(workspaceRow(page, scene.childA)).toHaveCount(0);
    const summary = childrenSummary(page, scene.parent);
    await expect(summary).toContainText("2 child workspaces:");
    const summaryId = await summary.getAttribute("id");
    await expect(workspaceRow(page, scene.parent)).toHaveAttribute(
      "aria-describedby",
      summaryId ?? "",
    );

    await page.reload();
    await waitForSidebarHydration(page);
    await expect(disclosure(page, scene.parent)).toHaveAttribute("aria-expanded", "false");
    await disclosure(page, scene.parent).click();
    await expect(workspaceRow(page, scene.childA)).toBeVisible();
    await expect(childrenSummary(page, scene.parent)).toHaveCount(0);
  });

  test("opening a child reveals its collapsed family without changing the saved choice", async ({
    page,
  }) => {
    await openProjectViewWithCustomSort(page);
    await disclosure(page, scene.parent).click();
    await expect(workspaceRow(page, scene.childA)).toHaveCount(0);

    await gotoWorkspace(page, scene.childA);
    await expect(workspaceRow(page, scene.childA)).toHaveAttribute("aria-selected", "true");
    await expect(disclosure(page, scene.parent)).toHaveAttribute("aria-expanded", "true");
    await expect(disclosure(page, scene.parent)).toBeDisabled();

    await gotoWorkspace(page, scene.independent);
    await expect(disclosure(page, scene.parent)).toHaveAttribute("aria-expanded", "false");
    await expect(workspaceRow(page, scene.childA)).toHaveCount(0);
  });

  test("dragging a child reorders its siblings and leaves the parent in place", async ({
    page,
  }) => {
    await openProjectViewWithCustomSort(page);
    const parentRow = workspaceRow(page, scene.parent);
    const parentTop = (await parentRow.boundingBox())!.y;
    const children = rowsOf(page, [scene.childA, scene.childB]);
    const before = await sidebarRowTestIds(children);

    await quickDragFirstSidebarRowAfterSecond(children, pressSidebarWorkspaceRow);
    expect((await parentRow.boundingBox())!.y).toBe(parentTop);

    await page.reload();
    await waitForSidebarHydration(page);
    await expect.poll(() => sidebarRowTestIds(children)).toEqual([before[1], before[0]]);
    const family = page.getByTestId(`sidebar-workspace-family-${key(scene.parent)}`);
    await expect(family.locator('[data-testid^="sidebar-workspace-row-"]').first()).toHaveAttribute(
      "data-testid",
      `sidebar-workspace-row-${key(scene.parent)}`,
    );
  });

  test("dragging a parent below an independent root moves its whole family", async ({ page }) => {
    await openProjectViewWithCustomSort(page);
    const roots = rowsOf(page, [scene.parent, scene.independent]);
    if ((await sidebarRowTestIds(roots))[0] !== `sidebar-workspace-row-${key(scene.parent)}`) {
      const family = page.getByTestId(`sidebar-workspace-family-${key(scene.parent)}`);
      await quickDragFirstSidebarRowAfterSecond(roots, pressSidebarWorkspaceRow, family);
    }
    await quickDragFirstSidebarRowAfterSecond(roots, pressSidebarWorkspaceRow);

    const everyRow = rowsOf(page, [scene.parent, scene.childA, scene.childB, scene.independent]);
    const order = await sidebarRowTestIds(everyRow);
    expect(order[0]).toBe(`sidebar-workspace-row-${key(scene.independent)}`);
    expect(order[1]).toBe(`sidebar-workspace-row-${key(scene.parent)}`);
    expect(order.slice(2).sort()).toEqual(
      [scene.childA, scene.childB].map((id) => `sidebar-workspace-row-${key(id)}`).sort(),
    );
  });
});
