import type { Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { runWorkspaceActionFromCommandCenter } from "../support/helpers/command-center-workspace-actions";

interface DragMeasurement {
  observer: MutationObserver;
  stylesheetMutations: number;
}

declare global {
  interface Window {
    __PASEO_EXPLORER_DRAG_MEASUREMENT__?: DragMeasurement;
  }
}

async function waitForResizePaint(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function beginResizeMeasurement(page: Page): Promise<void> {
  await page.evaluate(() => {
    const stylesheet = document.getElementById("unistyles-web");
    if (!stylesheet) throw new Error("Shared stylesheet is missing");
    globalThis.__PASEO_RESET_RENDER_PROFILE__!();
    const measurement: DragMeasurement = {
      stylesheetMutations: 0,
      observer: new MutationObserver((records) => {
        measurement.stylesheetMutations += records.length;
      }),
    };
    measurement.observer.observe(stylesheet, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    window.__PASEO_EXPLORER_DRAG_MEASUREMENT__ = measurement;
  });
}

async function previewExplorerResize(page: Page, distance: number) {
  const handle = page
    .getByTestId("workspace-explorer-sidebar-resize-handle")
    .getByRole("separator");
  const explorer = page.getByTestId("workspace-explorer-sidebar");
  const bounds = await handle.boundingBox();
  if (!bounds) throw new Error("Explorer resize handle is missing");
  const before = (await explorer.boundingBox())!.width;
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + 100;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await waitForResizePaint(page);
  await beginResizeMeasurement(page);
  for (let move = 1; move <= 20; move++) {
    await page.mouse.move(x + (distance * move) / 20, y);
    await waitForResizePaint(page);
  }
  const during = (await explorer.boundingBox())!.width;
  const measurement = await page.evaluate(() => {
    const state = window.__PASEO_EXPLORER_DRAG_MEASUREMENT__!;
    state.observer.disconnect();
    return {
      stylesheetMutations: state.stylesheetMutations,
      paneRenders: Object.entries(globalThis.__PASEO_RENDER_PROFILE_REASONS__ ?? {})
        .filter(([id]) => id.startsWith("SplitPaneView:"))
        .reduce((sum, [, reasons]) => sum + (reasons.render ?? 0), 0),
    };
  });
  await page.mouse.up();
  await waitForResizePaint(page);
  const after = (await explorer.boundingBox())!.width;
  expect(during).toBeCloseTo(before - distance, 0);
  expect(after).toBeCloseTo(during, 0);
  return { ...measurement, width: after };
}

async function expectExplorerWidthSurvivesReload(page: Page, width: number): Promise<void> {
  await page.reload();
  const explorer = page.getByTestId("workspace-explorer-sidebar");
  await expect(explorer).toBeVisible();
  await expect.poll(async () => (await explorer.boundingBox())?.width).toBeCloseTo(width, 0);
}

test("Explorer drag previews without rerendering panes or rewriting the shared stylesheet", async ({
  page,
  withWorkspace,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.addInitScript(() => {
    globalThis.__PASEO_RENDER_PROFILE_ENABLED__ = true;
  });
  const workspace = await withWorkspace();
  await workspace.navigateTo();
  await runWorkspaceActionFromCommandCenter(page, "Split pane right");
  await runWorkspaceActionFromCommandCenter(page, "Split pane right");
  await page.getByTestId("workspace-explorer-toggle").first().click();
  await expect(page.getByTestId("workspace-explorer-sidebar")).toBeVisible();
  // Verify that direct pane renders are being counted before resetting them.
  expect(
    await page.evaluate(() =>
      Object.keys(globalThis.__PASEO_RENDER_PROFILE_REASONS__ ?? {}).some((id) =>
        id.startsWith("SplitPaneView:"),
      ),
    ),
  ).toBe(true);
  const grown = await previewExplorerResize(page, -100);
  const shrunk = await previewExplorerResize(page, 50);
  expect(grown.stylesheetMutations).toBe(0);
  expect(grown.paneRenders).toBe(0);
  expect(shrunk.stylesheetMutations).toBe(0);
  expect(shrunk.paneRenders).toBe(0);
  await expectExplorerWidthSurvivesReload(page, shrunk.width);
});

test("Explorer divider hover presets honor pixel minimums and persist exact widths", async ({
  page,
  withWorkspace,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const workspace = await withWorkspace();
  await workspace.navigateTo();
  await page.getByTestId("workspace-explorer-toggle").first().click();
  const explorer = page.getByTestId("workspace-explorer-sidebar");
  await expect(explorer).toBeVisible();
  const handle = page.getByTestId("workspace-explorer-sidebar-resize-handle");
  const separator = handle.getByRole("separator");
  const bounds = await separator.boundingBox();
  if (!bounds) throw new Error("Explorer divider is missing");
  // Enter the existing full divider hot area away from its center, as a real pointer would.
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 100);
  const presets = page.getByTestId("workspace-split-presets");
  await expect(presets).toBeVisible();
  const preset = page.getByTestId("workspace-split-preset-60-40");
  await expect(preset).toBeEnabled();
  const shellWidth = await explorer.evaluate((element) => {
    let shell = element.parentElement;
    while (
      shell &&
      !shell.querySelector('[data-testid="workspace-explorer-sidebar-resize-handle"]')
    ) {
      shell = shell.parentElement;
    }
    if (!shell) throw new Error("Explorer dock shell is missing");
    return shell.getBoundingClientRect().width;
  });
  await preset.click();
  await expect
    .poll(async () => (await explorer.boundingBox())?.width)
    .toBeCloseTo(shellWidth * 0.4, 0);
  await expectExplorerWidthSurvivesReload(page, shellWidth * 0.4);

  // At this viewport the body is narrower than 400 / .3, making 30/70 impossible.
  await page.setViewportSize({ width: 1000, height: 1000 });
  const narrowBounds = await separator.boundingBox();
  if (!narrowBounds) throw new Error("Explorer divider is missing after resize");
  await page.mouse.move(narrowBounds.x + narrowBounds.width / 2, narrowBounds.y + 100);
  await expect(presets).toBeVisible();
  await expect(page.getByTestId("workspace-split-preset-30-70")).toBeDisabled();
  // A disabled choice cannot write a clamped substitute width.
  const retainedWidth = (await explorer.boundingBox())!.width;
  await page.keyboard.press("Escape");
  await expectExplorerWidthSurvivesReload(page, retainedWidth);
});
