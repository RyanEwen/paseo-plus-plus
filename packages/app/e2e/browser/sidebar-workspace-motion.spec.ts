import type { Locator, Page, TestInfo } from "@playwright/test";
import { SIDEBAR_POSITION_TRANSITION_MS } from "../../src/components/sidebar/position-transition-timing";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import {
  closeMobileAgentSidebar,
  closeSidebarDisplayPreferences,
  openSidebarDisplayPage,
  expectMobileAgentSidebarHidden,
  openMobileAgentSidebar,
  selectSidebarProjectGrouping,
} from "../support/helpers/sidebar";
import {
  expectSidebarMotionPaused,
  resumeSidebarMotion,
  seedSidebarMotionPreferences,
  startSidebarMotionProbe,
  stopSidebarMotionProbe,
} from "../support/helpers/sidebar-motion";
import {
  pressSidebarProjectRow,
  quickDragFirstSidebarRowAfterSecond,
} from "../support/helpers/sidebar-drag";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

type MockWorkspace = Awaited<ReturnType<typeof seedMockAgentWorkspace>>;

const DESKTOP = { width: 1440, height: 900 };
const COMPACT = { width: 390, height: 844 };

/** Seed a workspace whose mock agent finished, with its completion already read (Done). */
async function seedFinishedWorkspace(repoPrefix: string, title: string): Promise<MockWorkspace> {
  const seed = await seedMockAgentWorkspace({ repoPrefix, title, initialPrompt: "Finish." });
  await seed.client.waitForFinish(seed.agentId, 20_000);
  await seed.client.clearWorkspaceAttention(seed.workspaceId);
  return seed;
}

/** Seed the moving subject and a second Done workspace that gives the move a real distance. */
async function seedTwoFinishedWorkspaces(prefix: string) {
  const subject = await seedFinishedWorkspace(`${prefix}-subject-`, "Subject");
  const other = await seedFinishedWorkspace(`${prefix}-other-`, "Other");
  return { subject, other };
}

function workspaceKey(seed: MockWorkspace): string {
  return `${getServerId()}:${seed.workspaceId}`;
}

function workspaceRowTestId(seed: MockWorkspace): string {
  return `sidebar-workspace-row-${workspaceKey(seed)}`;
}

async function rowTestIds(rows: Locator): Promise<string[]> {
  return rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid") ?? ""));
}

type ProbeFrames = Awaited<ReturnType<typeof stopSidebarMotionProbe>>;

/** The first frame painted in Done after the row had reached Unread. */
function firstReturnToDone(frames: ProbeFrames) {
  const reachedAttention = frames.findIndex(
    (frame) => frame.group === "sidebar-status-group-rows-attention",
  );
  if (reachedAttention === -1) return undefined;
  return frames
    .slice(reachedAttention + 1)
    .find((frame) => frame.group === "sidebar-status-group-rows-done");
}

/** Running position transitions on the row's animated wrapper. */
async function runningTransitions(row: Locator): Promise<number> {
  return row.evaluate(
    (node) => node.closest("[data-position-transition]")?.getAnimations().length ?? 0,
  );
}

async function expectTransitionsSettled(row: Locator): Promise<void> {
  await expect.poll(() => runningTransitions(row)).toBe(0);
}

/** Open the rename dialog from the row's menu and type a draft without saving it. */
async function openRenameWithDraft(page: Page, seed: MockWorkspace, draft: string) {
  const key = workspaceKey(seed);
  await page.getByTestId(workspaceRowTestId(seed)).hover();
  await page.getByTestId(`sidebar-workspace-kebab-${key}`).click();
  await page.getByTestId(`sidebar-workspace-menu-rename-${key}`).click();
  const input = page.getByTestId(`sidebar-workspace-rename-modal-${key}-input`);
  await input.fill(draft);
  return input;
}

async function cancelRename(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
}

function statusGroupRows(page: Page, bucket: string): Locator {
  return page.getByTestId(`sidebar-status-group-rows-${bucket}`);
}

function statusGroupHeader(page: Page, bucket: string): Locator {
  return page.getByTestId(`sidebar-status-group-${bucket}`);
}

/**
 * Assert the Status group heading counts. A bucket mapped to `null` has no heading at all,
 * so its count must not render.
 */
async function expectStatusGroupCounts(
  page: Page,
  counts: Record<string, number | null>,
): Promise<void> {
  for (const [bucket, count] of Object.entries(counts)) {
    const countText = page.getByTestId(`sidebar-status-group-count-${bucket}`);
    if (count === null) {
      await expect(countText).toHaveCount(0);
    } else {
      await expect(countText).toHaveText(String(count));
    }
  }
}

/**
 * Move the subject from Done to Unread and back while a probe watches it, then check that the
 * same row slid with the sidebar duration, kept focus, and kept an open rename draft. The Status
 * group counts follow each move.
 */
async function expectStatusMoveKeepsRowAndDraft(
  page: Page,
  testInfo: TestInfo,
  seed: MockWorkspace,
) {
  const rowTestId = workspaceRowTestId(seed);
  const row = page.getByTestId(rowTestId);
  await expectStatusGroupCounts(page, { done: 2, attention: null });
  // Visibility starts during the compact drawer's entrance. Wait for real actionability
  // before measuring the independent row transition, without clicking or changing focus.
  await row.click({ trial: true });
  await row.focus();
  await page.screenshot({ path: testInfo.outputPath("motion-before.png") });
  await startSidebarMotionProbe({ page, rowTestId, freeze: true });
  await seed.client.markWorkspaceUnread(seed.workspaceId);
  await expectSidebarMotionPaused(page);
  await expectStatusGroupCounts(page, { done: 1, attention: 1 });
  await page.screenshot({ path: testInfo.outputPath("motion-middle.png") });
  await expect(row).toBeFocused();
  await resumeSidebarMotion(page);
  await expectTransitionsSettled(row);
  await page.screenshot({ path: testInfo.outputPath("motion-after.png") });
  const frames = await stopSidebarMotionProbe(page);
  expect(frames.every((frame) => frame.connected && frame.sameNode)).toBe(true);
  expect(frames.some((frame) => frame.duration === SIDEBAR_POSITION_TRANSITION_MS)).toBe(true);
  expect(new Set(frames.map((frame) => Math.round(frame.top))).size).toBeGreaterThan(2);
  await testInfo.attach("motion-frames.json", {
    body: JSON.stringify(frames),
    contentType: "application/json",
  });

  const input = await openRenameWithDraft(page, seed, "Unsaved rename survives movement");
  await seed.client.clearWorkspaceAttention(seed.workspaceId);
  await expect(statusGroupRows(page, "done").getByTestId(rowTestId)).toBeVisible();
  await expect(input).toHaveValue("Unsaved rename survives movement");
  await expect(input).toBeFocused();
  await expectStatusGroupCounts(page, { done: 2, attention: null });
  await cancelRename(page);
}

/** A status change while the sidebar is hidden must not replay as motion when it is revealed. */
async function expectRevealWithoutMotion(
  page: Page,
  seed: MockWorkspace,
  reveal: () => Promise<void>,
) {
  const rowTestId = workspaceRowTestId(seed);
  const row = page.getByTestId(rowTestId);
  await seed.client.markWorkspaceUnread(seed.workspaceId);
  await expect(row.getByTestId("workspace-status-indicator-attention")).toHaveCount(1);
  await startSidebarMotionProbe({ page, rowTestId });
  await reveal();
  const frames = await stopSidebarMotionProbe(page);
  expect(frames.every((frame) => frame.duration === null && frame.sameNode)).toBe(true);
}

async function hasHiddenAncestor(row: Locator): Promise<boolean> {
  return row.evaluate((node) => {
    for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (getComputedStyle(ancestor).display === "none") return true;
    }
    return false;
  });
}

/**
 * Status moves are immediate (no running transition on any frame) and stay immediate after a
 * reload, for a sidebar whose motion is disabled.
 */
async function expectInstantStatusMovesAcrossReload(page: Page, seed: MockWorkspace) {
  const rowTestId = workspaceRowTestId(seed);
  for (const reload of [false, true]) {
    if (reload) await page.reload();
    await expect(page.getByTestId(rowTestId)).toBeVisible({ timeout: 30_000 });
    await startSidebarMotionProbe({ page, rowTestId });
    await seed.client.markWorkspaceUnread(seed.workspaceId);
    await expect(statusGroupRows(page, "attention").getByTestId(rowTestId)).toBeVisible();
    const frames = await stopSidebarMotionProbe(page);
    expect(frames.every((frame) => frame.duration === null && frame.sameNode)).toBe(true);
    await seed.client.clearWorkspaceAttention(seed.workspaceId);
    await expect(statusGroupRows(page, "done").getByTestId(rowTestId)).toBeVisible();
  }
}

/** Scroll the sidebar so the header sits just above its scrollport, still inside the window. */
async function clipHeaderAboveScrollport(header: Locator): Promise<void> {
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
}

async function expectHeaderClipped(header: Locator): Promise<void> {
  const clipping = await header.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const overflow = getComputedStyle(parent).overflowY;
      if (overflow === "auto" || overflow === "scroll") {
        return {
          top: bounds.top,
          bottom: bounds.bottom,
          scrollTop: parent.getBoundingClientRect().top,
        };
      }
    }
    throw new Error("No sidebar scrollport");
  });
  expect(clipping.top).toBeGreaterThan(0);
  expect(clipping.bottom).toBeLessThan(clipping.scrollTop);
}

/**
 * Seed a subject and enough Done workspaces that the sidebar scrolls and Done hits its count
 * limit. Titles sort the subject (Zeta) after every Alpha workspace.
 */
async function seedScrollableStatusScene(prefix: string) {
  const { subject, other } = await seedTwoFinishedWorkspaces(prefix);
  await subject.client.setWorkspaceTitle(subject.workspaceId, "Zeta");
  await other.client.setWorkspaceTitle(other.workspaceId, "Alpha");
  for (let index = 0; index < 21; index++) {
    const workspace = await other.client.createWorkspace({
      source: { kind: "directory", path: other.cwd },
      title: `Alpha ${index}`,
    });
    if (!workspace.workspace)
      throw new Error(workspace.error ?? "Could not seed sidebar scroll range");
  }
  return { subject, other };
}

/** Run one mock agent to completion in a workspace and read its completion, leaving it Done. */
async function finishAgentInWorkspace(
  client: Awaited<ReturnType<typeof seedWorkspace>>["client"],
  workspaceId: string,
  cwd: string,
): Promise<void> {
  const agent = await client.createAgent({
    provider: "mock",
    cwd,
    workspaceId,
    modeId: "load-test",
    model: "e2e-fast-stream",
    initialPrompt: "Finish.",
  });
  await client.waitForFinish(agent.id, 20_000);
  await client.clearWorkspaceAttention(workspaceId);
}

test.describe("Sidebar workspace motion", () => {
  test("status moves keep row identity, focus and rename drafts on desktop", async ({
    page,
  }, testInfo) => {
    const { subject, other } = await seedTwoFinishedWorkspaces("sidebar-motion-desktop");
    try {
      await page.setViewportSize(DESKTOP);
      await seedSidebarMotionPreferences({ page, enabled: true });
      await gotoAppShell(page);
      const row = page.getByTestId(workspaceRowTestId(subject));
      await expect(row).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId(workspaceRowTestId(other))).toBeVisible();

      await expectStatusMoveKeepsRowAndDraft(page, testInfo, subject);

      await page.keyboard.press("Control+b");
      await expect(row).not.toBeVisible();
      await expect.poll(() => hasHiddenAncestor(row)).toBe(true);
      await expectRevealWithoutMotion(page, subject, async () => {
        await page.keyboard.press("Control+b");
        await expect(row).toBeVisible();
      });
      await page.screenshot({ path: testInfo.outputPath("desktop-hidden-status-reveal.png") });
    } finally {
      await subject.cleanup();
      await other.cleanup();
    }
  });

  test("status moves keep row identity, focus and rename drafts in the compact drawer", async ({
    page,
  }, testInfo) => {
    const { subject, other } = await seedTwoFinishedWorkspaces("sidebar-motion-compact");
    try {
      await page.setViewportSize(COMPACT);
      await seedSidebarMotionPreferences({ page, enabled: true });
      await gotoAppShell(page);
      await openMobileAgentSidebar(page);
      const row = page.getByTestId(workspaceRowTestId(subject));
      await expect(row).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId(workspaceRowTestId(other))).toBeVisible();

      await expectStatusMoveKeepsRowAndDraft(page, testInfo, subject);

      await closeMobileAgentSidebar(page);
      await expectMobileAgentSidebarHidden(page);
      await expectRevealWithoutMotion(page, subject, async () => {
        await openMobileAgentSidebar(page);
        await expect(row).toBeInViewport();
      });
      await page.screenshot({ path: testInfo.outputPath("hidden-status-reveal.png") });
    } finally {
      await subject.cleanup();
      await other.cleanup();
    }
  });

  test("status moves instantly when the setting is off and after a reload", async ({ page }) => {
    const subject = await seedFinishedWorkspace("sidebar-motion-off-", "Subject");
    try {
      await seedSidebarMotionPreferences({ page, enabled: true });
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await gotoAppShell(page);
      await page.goto("/settings/paseo-plus-plus");
      const toggle = page.getByRole("switch", { name: "Animate workspace moves", exact: true });
      await expect(toggle).toBeChecked();
      await toggle.click();
      await expect(toggle).not.toBeChecked();
      await gotoAppShell(page);

      await expectInstantStatusMovesAcrossReload(page, subject);
    } finally {
      await subject.cleanup();
    }
  });

  test("status moves instantly with reduced motion and after a reload", async ({ page }) => {
    const subject = await seedFinishedWorkspace("sidebar-motion-reduced-", "Subject");
    try {
      await seedSidebarMotionPreferences({ page, enabled: true });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await gotoAppShell(page);

      await expectInstantStatusMovesAcrossReload(page, subject);
    } finally {
      await subject.cleanup();
    }
  });

  test("rapid status reversal starts from the interrupted painted position", async ({ page }) => {
    const { subject, other } = await seedTwoFinishedWorkspaces("sidebar-motion-interrupt");
    try {
      await seedSidebarMotionPreferences({ page, enabled: true });
      await gotoAppShell(page);
      const rowTestId = workspaceRowTestId(subject);
      const row = page.getByTestId(rowTestId);
      await expect(row).toBeVisible({ timeout: 30_000 });
      await startSidebarMotionProbe({ page, rowTestId, freeze: true });
      await subject.client.markWorkspaceUnread(subject.workspaceId);
      await expectSidebarMotionPaused(page);
      const interruptedTop = (await row.boundingBox())!.y;
      await subject.client.clearWorkspaceAttention(subject.workspaceId);
      await expect(statusGroupRows(page, "done").getByTestId(rowTestId)).toBeVisible();
      await expectTransitionsSettled(row);
      const frames = await stopSidebarMotionProbe(page);
      const firstReturn = firstReturnToDone(frames);
      expect(firstReturn).toBeDefined();
      expect(Math.abs(firstReturn!.top - interruptedTop)).toBeLessThan(12);
      expect(frames.every((frame) => frame.sameNode && frame.connected)).toBe(true);

      // The newly completed subject is first in Done. Changing only its bucket
      // keeps the same layout position and must not create artificial movement.
      const stationaryTop = (await row.boundingBox())!.y;
      await startSidebarMotionProbe({ page, rowTestId });
      await subject.client.markWorkspaceUnread(subject.workspaceId);
      await expect(statusGroupRows(page, "attention").getByTestId(rowTestId)).toBeVisible();
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
      const doneRows = statusGroupRows(page, "done").locator(
        '[data-testid^="sidebar-workspace-row-"]',
      );
      await expect.poll(() => rowTestIds(doneRows)).toEqual([workspaceRowTestId(other), rowTestId]);
      await expectTransitionsSettled(row);
      await startSidebarMotionProbe({ page, rowTestId, freeze: true });
      await subject.client.markWorkspaceUnread(subject.workspaceId);
      await expectSidebarMotionPaused(page);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await expectTransitionsSettled(row);
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
    const { subject, other } = await seedTwoFinishedWorkspaces("sidebar-motion-hidden");
    try {
      await other.client.markWorkspaceUnread(other.workspaceId);
      await seedSidebarMotionPreferences({ page, enabled: true });
      await gotoAppShell(page);
      const row = page.getByTestId(workspaceRowTestId(subject));
      const header = statusGroupHeader(page, "attention");
      await expect(row).toBeVisible({ timeout: 30_000 });
      await header.click();
      await expect(header).toHaveAttribute("aria-expanded", "false");

      // A move into the collapsed group keeps the dialog's draft and focus, and the group shut.
      const input = await openRenameWithDraft(page, subject, "Keep this hidden-row draft");
      await subject.client.markWorkspaceUnread(subject.workspaceId);
      await expect(row).toHaveCount(0);
      await expect(input).toHaveValue("Keep this hidden-row draft");
      await expect(input).toBeFocused();
      await expect(header).toHaveAttribute("aria-expanded", "false");
      await cancelRename(page);

      // A focused row that moves into the collapsed group hands focus to that group's header.
      await subject.client.clearWorkspaceAttention(subject.workspaceId);
      await expect(row).toBeVisible();
      await row.focus();
      await subject.client.markWorkspaceUnread(subject.workspaceId);
      await expect(row).toHaveCount(0);
      await expect(header).toBeFocused();
      await expect(header).toHaveAttribute("aria-expanded", "false");
      await expect(statusGroupRows(page, "attention")).toHaveCount(0);

      await page.reload();
      await expect(header).toHaveAttribute("aria-expanded", "false", { timeout: 30_000 });
      await expect(statusGroupRows(page, "attention")).toHaveCount(0);
    } finally {
      await subject.cleanup();
      await other.cleanup();
    }
  });

  test("a header clipped above the scrollport cannot take focus for a collapsed destination", async ({
    page,
  }, testInfo) => {
    const { subject, other } = await seedScrollableStatusScene("sidebar-clipped-collapsed");
    try {
      await other.client.markWorkspaceUnread(other.workspaceId);
      await seedSidebarMotionPreferences({ page, enabled: true, workspaceSortMode: "status" });
      await page.setViewportSize(DESKTOP);
      await gotoAppShell(page);
      const row = page.getByTestId(workspaceRowTestId(subject));
      const header = statusGroupHeader(page, "attention");
      // Blank workspaces deliberately fill the initial limit. Reveal the source
      // during setup without changing the collapsed destination on status moves.
      await page.getByTestId("sidebar-status-group-show-more-done").click();
      await expect(row).toBeVisible({ timeout: 30_000 });
      await header.click();
      await expect(header).toHaveAttribute("aria-expanded", "false");
      await row.focus();
      await clipHeaderAboveScrollport(header);
      await expectHeaderClipped(header);
      await expect(row).toBeFocused();
      await page.screenshot({ path: testInfo.outputPath("collapsed-header-clipped.png") });

      await subject.client.markWorkspaceUnread(subject.workspaceId);
      await expect(row).toHaveCount(0);
      await expect(header).not.toBeFocused();
      await expect(header).toHaveAttribute("aria-expanded", "false");
      await expect(statusGroupHeader(page, "done")).toHaveAttribute("aria-expanded", "true");
    } finally {
      await subject.cleanup();
      await other.cleanup();
    }
  });

  test("a header clipped above the scrollport cannot take focus for a destination behind Show more", async ({
    page,
  }, testInfo) => {
    const { subject, other } = await seedScrollableStatusScene("sidebar-clipped-limit");
    try {
      await subject.client.markWorkspaceUnread(subject.workspaceId);
      await seedSidebarMotionPreferences({ page, enabled: true, workspaceSortMode: "name" });
      await page.setViewportSize(DESKTOP);
      await gotoAppShell(page);
      const row = page.getByTestId(workspaceRowTestId(subject));
      const header = statusGroupHeader(page, "done");
      await expect(row).toBeVisible({ timeout: 30_000 });
      await row.focus();
      await clipHeaderAboveScrollport(header);
      await expectHeaderClipped(header);
      await expect(row).toBeFocused();
      await page.screenshot({ path: testInfo.outputPath("limit-header-clipped.png") });

      await subject.client.clearWorkspaceAttention(subject.workspaceId);
      await expect(row).toHaveCount(0);
      await expect(header).not.toBeFocused();
      await expect(header).toHaveAttribute("aria-expanded", "true");
      await expect(
        statusGroupRows(page, "done").locator('[data-testid^="sidebar-workspace-row-"]'),
      ).toHaveCount(20);
      await expect(page.getByTestId("sidebar-status-group-show-more-done")).toContainText(
        "Show more",
      );
    } finally {
      await subject.cleanup();
      await other.cleanup();
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
      await page.getByTestId("sidebar-display-preferences-menu").click();
      await page.getByTestId("sidebar-one-project-at-a-time").click();
      await closeSidebarDisplayPreferences(page);
      const largeHeader = page.getByTestId(`sidebar-project-row-${large.projectKey}`);
      const smallHeader = page.getByTestId(`sidebar-project-row-${small.projectKey}`);
      // Collapse the large project, then expand it alone: every other project collapses.
      await largeHeader.click();
      await largeHeader.click();
      await expect(
        page.getByTestId(`sidebar-workspace-row-${getServerId()}:${large.workspaceId}`),
      ).toBeVisible();
      await expect(
        page
          .getByRole("group", { name: "Anchor 00", exact: true })
          .locator('[data-testid^="sidebar-workspace-row-"]'),
      ).toHaveCount(16);
      await expect(
        page.getByTestId(`sidebar-workspace-row-${getServerId()}:${small.workspaceId}`),
      ).toHaveCount(0);
      await smallHeader.scrollIntoViewIfNeeded();
      const smallHeaderTestId = `sidebar-project-row-${small.projectKey}`;
      await startSidebarMotionProbe({
        page,
        rowTestId: smallHeaderTestId,
        viewportTestId: "sidebar-project-workspace-list-scroll",
      });

      await smallHeader.click();
      await expect(
        page.getByTestId(`sidebar-workspace-row-${getServerId()}:${small.workspaceId}`),
      ).toBeVisible();
      await expectTransitionsSettled(smallHeader);
      const frames = await stopSidebarMotionProbe(page);

      const samples = frames.flatMap((frame) =>
        frame.viewport ? [{ header: frame, viewport: frame.viewport }] : [],
      );
      expect(samples.length).toBeGreaterThan(2);
      const first = samples[0]!;
      const last = samples.at(-1)!;
      expect(first.viewport.scrollTop).toBeGreaterThan(200);
      for (const { header, viewport } of samples) {
        expect(header.top).toBeGreaterThanOrEqual(viewport.top - 2);
        expect(header.bottom).toBeLessThanOrEqual(viewport.bottom + 2);
      }
      expect(last.viewport.scrollTop).toBeLessThan(first.viewport.scrollTop);
      // The selected project becomes topmost; preceding collapsed projects remain above the viewport.
      expect(last.viewport.scrollTop).toBeGreaterThan(0);
      expect(Math.abs(last.header.top - last.viewport.top)).toBeLessThanOrEqual(2);
      await expect(
        page.getByTestId(`sidebar-workspace-row-${getServerId()}:${large.workspaceId}`),
      ).toHaveCount(0);
      await testInfo.attach("accordion-animation-frames", {
        body: JSON.stringify(samples, null, 2),
        contentType: "application/json",
      });
      await page.screenshot({ path: testInfo.outputPath("accordion-selected-project.png") });
    } finally {
      for (const seed of projects.toReversed()) await seed.cleanup();
    }
  });

  test("project and child status moves count ancestor motion once, including a later child move", async ({
    page,
  }, testInfo) => {
    const subject = await seedWorkspace({ repoPrefix: "sidebar-nested-motion-subject-" });
    const other = await seedWorkspace({ repoPrefix: "sidebar-nested-motion-other-" });
    try {
      await finishAgentInWorkspace(subject.client, subject.workspaceId, subject.repoPath);
      const sibling = await subject.client.createWorkspace({
        source: { kind: "directory", path: subject.repoPath, projectId: subject.projectId },
        title: "Sibling",
      });
      if (!sibling.workspace) throw new Error(sibling.error ?? "No sibling workspace");
      await finishAgentInWorkspace(subject.client, sibling.workspace.id, subject.repoPath);
      await finishAgentInWorkspace(other.client, other.workspaceId, other.repoPath);
      await seedSidebarMotionPreferences({ page, enabled: true, groupMode: "project" });
      await gotoAppShell(page);
      const subjectProjectId = `sidebar-project-row-${subject.projectKey}`;
      const otherProjectId = `sidebar-project-row-${other.projectKey}`;
      const projects = page.locator(
        `[data-testid="${subjectProjectId}"], [data-testid="${otherProjectId}"]`,
      );
      await expect(projects).toHaveCount(2);
      await openSidebarDisplayPage(page, "sidebar-display-sorting");
      await page.getByTestId("sidebar-sorting-custom").click();
      if ((await rowTestIds(projects))[0] === subjectProjectId)
        await quickDragFirstSidebarRowAfterSecond(projects, pressSidebarProjectRow);
      await openSidebarDisplayPage(page, "sidebar-display-sorting");
      await page.getByTestId("sidebar-sorting-status").click();
      await closeSidebarDisplayPreferences(page);
      const rowTestId = `sidebar-workspace-row-${getServerId()}:${subject.workspaceId}`;
      const siblingTestId = `sidebar-workspace-row-${getServerId()}:${sibling.workspace.id}`;
      const row = page.getByTestId(rowTestId);
      await expect(row).toBeVisible();
      const before = (await row.boundingBox())!.y;
      await page.screenshot({ path: testInfo.outputPath("nested-motion-before.png") });
      await startSidebarMotionProbe({ page, rowTestId, freeze: true });
      await subject.client.markWorkspaceUnread(subject.workspaceId);
      await expectSidebarMotionPaused(page);
      await page.screenshot({ path: testInfo.outputPath("nested-motion-middle.png") });
      await resumeSidebarMotion(page);
      await expectTransitionsSettled(row);
      await expect.poll(() => rowTestIds(projects)).toEqual([subjectProjectId, otherProjectId]);
      const after = (await row.boundingBox())!.y;
      await page.screenshot({ path: testInfo.outputPath("nested-motion-after.png") });
      const frames = await stopSidebarMotionProbe(page);
      expect(after).toBeLessThan(before - 10);
      expect(Math.min(...frames.map((frame) => frame.top))).toBeGreaterThanOrEqual(after - 2);
      expect(Math.max(...frames.map((frame) => frame.top))).toBeLessThanOrEqual(before + 2);
      expect(frames.every((frame) => frame.sameNode && frame.connected)).toBe(true);
      await testInfo.attach("nested-motion-frames.json", {
        body: JSON.stringify(frames),
        contentType: "application/json",
      });

      await other.client.markWorkspaceUnread(other.workspaceId);
      await expect.poll(() => rowTestIds(projects)).toEqual([otherProjectId, subjectProjectId]);
      await expectTransitionsSettled(page.getByTestId(subjectProjectId));
      const beforeChildMove = (await row.boundingBox())!.y;
      await startSidebarMotionProbe({ page, rowTestId });
      await subject.client.markWorkspaceUnread(sibling.workspace.id);
      const familyRows = page.locator(
        `[data-testid="${rowTestId}"], [data-testid="${siblingTestId}"]`,
      );
      await expect.poll(() => rowTestIds(familyRows)).toEqual([siblingTestId, rowTestId]);
      await expectTransitionsSettled(row);
      const afterChildMove = (await row.boundingBox())!.y;
      const childFrames = await stopSidebarMotionProbe(page);
      expect(afterChildMove).toBeGreaterThan(beforeChildMove + 10);
      expect(Math.min(...childFrames.map((frame) => frame.top))).toBeGreaterThanOrEqual(
        beforeChildMove - 2,
      );
      expect(Math.max(...childFrames.map((frame) => frame.top))).toBeLessThanOrEqual(
        afterChildMove + 2,
      );
    } finally {
      await subject.cleanup();
      await other.cleanup();
    }
  });
});
