import type { Locator, Page } from "@playwright/test";
import { expect } from "../fixtures";

/** The `data-testid` of every row matched by `rows`, in DOM order. */
export async function sidebarRowTestIds(rows: Locator): Promise<(string | null)[]> {
  return rows.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-testid")),
  );
}

/** A row's on-screen box; a drag needs the row rendered and laid out. */
async function visibleBoundingBox(row: Locator) {
  const box = await row.boundingBox();
  if (!box) throw new Error("Expected a visible draggable row");
  return box;
}

/** Press a project header. Project rows show no pressed feedback, so the press is immediate. */
export async function pressSidebarProjectRow(rows: Locator): Promise<void> {
  await rows.page().mouse.down();
}

/** Press a workspace row and wait for its pressed background, which arms the drag handle. */
export async function pressSidebarWorkspaceRow(rows: Locator): Promise<void> {
  const row = rows.nth(0);
  const hoveredBackground = await row.evaluate((node) => getComputedStyle(node).backgroundColor);
  await rows.page().mouse.down();
  await expect
    .poll(() => row.evaluate((node) => getComputedStyle(node).backgroundColor))
    .not.toBe(hoveredBackground);
}

/**
 * Release a sidebar drag. dnd-kit's pointer sensor keeps its document click blocker for 50 ms
 * after the drop, so wait before the next user action.
 */
export async function finishSidebarDrag(page: Page): Promise<void> {
  await page.mouse.up();
  await page.waitForTimeout(60);
}

/**
 * Drag the first of exactly two rows below the second with an immediate mouse gesture, then wait
 * until their order swaps.
 *
 * @param pressRow how to press the source row (project and workspace rows arm differently).
 */
export async function quickDragFirstSidebarRowAfterSecond(
  rows: Locator,
  pressRow: (rows: Locator) => Promise<void>,
): Promise<void> {
  await expect(rows).toHaveCount(2);
  const before = await sidebarRowTestIds(rows);
  const sourceBox = await visibleBoundingBox(rows.nth(0));
  const targetBox = await visibleBoundingBox(rows.nth(1));

  const page = rows.page();
  const source = { x: sourceBox.x + sourceBox.width / 2, y: sourceBox.y + sourceBox.height / 2 };
  const target = { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height / 2 };

  await page.mouse.move(source.x, source.y);
  await pressRow(rows);
  await page.mouse.move(source.x, source.y + 7);
  await expect
    .poll(() => rows.nth(0).evaluate((node) => getComputedStyle(node).borderTopWidth))
    .toBe("1px");
  await page.mouse.move(target.x, target.y, { steps: 4 });
  await finishSidebarDrag(page);

  await expect.poll(() => sidebarRowTestIds(rows)).toEqual([before[1], before[0]]);
}
