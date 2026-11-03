import { expect, type Locator, type Page } from "@playwright/test";
import { WorkspaceLayoutPersistedStateSchema } from "../../src/stores/workspace-layout-storage";
import {
  collectAllTabs,
  type SplitGroup,
  type SplitNode,
} from "../../src/stores/workspace-layout-actions";
import { MIN_SPLIT_SIZE } from "../../src/stores/workspace-layout-constants";
import { test } from "../support/fixtures";
import { runWorkspaceActionFromCommandCenter } from "../support/helpers/command-center-workspace-actions";
import { createCreationScenario } from "../support/helpers/creation";
import { clickNewChat, gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";

interface RecordedDividerPointer {
  type: string;
  clientX: number;
  clientY: number;
  pointerId: number;
  pointerType: string;
}

/** Observe browser input without changing capture, propagation or application state. */
async function captureDividerInput(page: Page) {
  return page.evaluateHandle(() => {
    const events: RecordedDividerPointer[] = [];
    const types: ("pointerdown" | "pointermove" | "pointerup" | "pointercancel")[] = [
      "pointerdown",
      "pointermove",
      "pointerup",
      "pointercancel",
    ];
    function record(event: PointerEvent) {
      events.push({
        type: event.type,
        clientX: event.clientX,
        clientY: event.clientY,
        pointerId: event.pointerId,
        pointerType: event.pointerType,
      });
    }
    for (const type of types) window.addEventListener(type, record, true);
    return {
      events,
      stop() {
        for (const type of types) window.removeEventListener(type, record, true);
      },
    };
  });
}

function measuredPaneIds(node: SplitNode): string[] {
  return node.kind === "pane" ? [node.pane.id] : node.group.children.flatMap(measuredPaneIds);
}

/** Match the actual rendered child identities, including an Explorer-pruned ancestor group. */
function measuredSplitGroup(node: SplitNode, children: string[][]): SplitGroup | null {
  if (node.kind === "pane") return null;
  const paneIds = new Set(children.flat());
  const projected = node.group.children
    .map((child) => measuredPaneIds(child).filter((id) => paneIds.has(id)))
    .filter((ids) => ids.length > 0);
  if (JSON.stringify(projected) === JSON.stringify(children)) return node.group;
  for (const child of node.group.children) {
    const match = measuredSplitGroup(child, children);
    if (match) return match;
  }
  return null;
}

/** Read one painted frame plus the owning persisted layout/overlay; never seed or repair it. */
async function dividerSnapshot(divider: Locator) {
  await divider
    .page()
    .evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const geometry = await divider.evaluate((element) => {
    function isChild(child: Element) {
      return ["split-group-child", "split-group-child-hidden"].includes(
        child.getAttribute("data-testid") ?? "",
      );
    }
    let group = element.parentElement;
    while (group && !Array.from(group.children).some(isChild)) group = group.parentElement;
    if (!group) throw new Error("Divider's owning rendered group is missing");
    const frame = group.getBoundingClientRect();
    let handle: Element = element;
    while (handle.parentElement !== group) {
      const parent = handle.parentElement;
      if (!parent) throw new Error("Divider detached from its owning group");
      handle = parent;
    }
    const preceding = Array.from(group.children).slice(
      0,
      Array.from(group.children).indexOf(handle),
    );
    const dividerIndex = preceding.filter(isChild).length - 1;
    const children = Array.from(group.children)
      .filter(isChild)
      .map((child) => {
        const rect = child.getBoundingClientRect();
        return {
          x: rect.x,
          width: rect.width,
          flexGrow: Number.parseFloat(getComputedStyle(child).flexGrow),
          paneIds: Array.from(child.querySelectorAll('[data-testid^="workspace-pane-"]')).map(
            (pane) => pane.getAttribute("data-testid")!.slice("workspace-pane-".length),
          ),
        };
      });
    const freeWidth = children.reduce((sum, child) => sum + child.width, 0);
    return {
      dividerX: element.getBoundingClientRect().x,
      dividerIndex,
      groupX: frame.x,
      groupC: frame.width,
      freeF: freeWidth,
      nonChildExtent: frame.width - freeWidth,
      children,
    };
  });
  const raw = await divider.page().evaluate(() => localStorage.getItem("workspace-layout-state"));
  if (!raw) throw new Error("Divider layout is not persisted");
  const persisted = WorkspaceLayoutPersistedStateSchema.parse(JSON.parse(raw).state);
  const children = geometry.children.map((child) => child.paneIds);
  for (const [workspaceKey, layout] of Object.entries(persisted.layoutByWorkspace)) {
    const group = measuredSplitGroup(layout.root, children);
    if (!group) continue;
    return {
      ...geometry,
      workspaceKey,
      groupId: group.id,
      fullChildIds: group.children.map((child) =>
        child.kind === "pane" ? child.pane.id : child.group.id,
      ),
      layoutSizes: group.sizes,
      storedRawSizes: persisted.splitSizesByWorkspace?.[workspaceKey]?.[group.id] ?? null,
    };
  }
  throw new Error("No persisted group matches the divider's actual child identities");
}

interface DividerEvidence {
  requestedDelta: number;
  before: Awaited<ReturnType<typeof dividerSnapshot>>;
  preview?: Awaited<ReturnType<typeof dividerSnapshot>>;
  committed?: Awaited<ReturnType<typeof dividerSnapshot>>;
  input?: RecordedDividerPointer[];
}

const DRAG_DISTANCE = -40;
const TOLERANCE_PX = 2;

function splitDividers(page: Page): Locator {
  return page.getByTestId("workspace-split-resize-handle").filter({ visible: true });
}

async function dividerX(divider: Locator): Promise<number> {
  const box = await divider.boundingBox();
  if (!box) throw new Error("Divider has no bounding box");
  return box.x;
}

async function dragDivider(
  divider: Locator,
  deltaX: number,
  preview?: () => Promise<void>,
): Promise<void> {
  const page = divider.page();
  const box = await divider.boundingBox();
  if (!box) throw new Error("Divider has no bounding box");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + deltaX, y, { steps: 8 });
  await preview?.();
  await page.mouse.up();
}

async function dragDividerWithTouch(
  divider: Locator,
  deltaX: number,
  preview?: () => Promise<void>,
): Promise<void> {
  const page = divider.page();
  const box = await divider.boundingBox();
  if (!box) throw new Error("Divider has no bounding box");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const input = await page.context().newCDPSession(page);
  try {
    await input.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let step = 1; step <= 8; step++) {
      await input.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: x + (deltaX * step) / 8, y }],
      });
    }
    await preview?.();
    await input.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await input.detach();
  }
}

async function splitIntoFourPanes(page: Page): Promise<void> {
  for (const expectedDividers of [1, 2, 3]) {
    await runWorkspaceActionFromCommandCenter(page, "Split pane right");
    await expect(splitDividers(page)).toHaveCount(expectedDividers);
  }
}

/** Build equal ordinary quarters through the same split/focus controls, keeping the unequal fixture separate. */
async function splitIntoBalancedFourPanes(page: Page): Promise<void> {
  await runWorkspaceActionFromCommandCenter(page, "Split pane right");
  await expect(splitDividers(page)).toHaveCount(1);
  await runWorkspaceActionFromCommandCenter(page, "Split pane right");
  await expect(splitDividers(page)).toHaveCount(2);
  await runWorkspaceActionFromCommandCenter(page, "Focus pane left");
  await runWorkspaceActionFromCommandCenter(page, "Focus pane left");
  await runWorkspaceActionFromCommandCenter(page, "Split pane right");
  await expect(splitDividers(page)).toHaveCount(3);
  const snapshot = await dividerSnapshot(splitDividers(page).first());
  expect(snapshot.children).toHaveLength(4);
  for (const child of snapshot.children) {
    expect(child.flexGrow).toBeCloseTo(0.25, 10);
  }
}

/** Require measured legal physical headroom before delegating the unchanged mouse drag. */
async function dragUnclampedDivider(
  divider: Locator,
  deltaX: number,
  preview?: () => Promise<void>,
): Promise<void> {
  const snapshot = await dividerSnapshot(divider);
  const left = snapshot.children[snapshot.dividerIndex];
  const right = snapshot.children[snapshot.dividerIndex + 1];
  if (!left || !right) throw new Error("Divider has no measured adjacent pane pair");
  const pairFraction = (left.width + right.width) / snapshot.freeF;
  const minimumPixels = Math.min(MIN_SPLIT_SIZE, pairFraction / 2) * snapshot.freeF;
  const projectedDelta = (deltaX / snapshot.groupC) * snapshot.freeF;
  const leftHeadroom = left.width + projectedDelta - minimumPixels;
  const rightHeadroom = right.width - projectedDelta - minimumPixels;
  await test.info().attach(`split-headroom-${snapshot.dividerIndex + 1}-${deltaX}`, {
    body: Buffer.from(
      JSON.stringify(
        {
          requestedDelta: deltaX,
          projectedDelta,
          left,
          right,
          groupC: snapshot.groupC,
          freeF: snapshot.freeF,
          minimumPixels,
          leftHeadroom,
          rightHeadroom,
        },
        null,
        2,
      ),
    ),
    contentType: "application/json",
  });
  expect(leftHeadroom, "left pane must have measured unclamped headroom").toBeGreaterThan(
    TOLERANCE_PX,
  );
  expect(rightHeadroom, "right pane must have measured unclamped headroom").toBeGreaterThan(
    TOLERANCE_PX,
  );
  await dragDivider(divider, deltaX, preview);
}

/** Compare persistent identities without requiring ephemeral New launcher tab IDs to survive reload. */
async function splitLifecycleIdentity(page: Page) {
  const snapshot = await dividerSnapshot(splitDividers(page).first());
  const raw = await page.evaluate(() => localStorage.getItem("workspace-layout-state"));
  if (!raw) throw new Error("Lifecycle layout is not persisted");
  const state = WorkspaceLayoutPersistedStateSchema.parse(JSON.parse(raw).state);
  const layout = state.layoutByWorkspace[snapshot.workspaceKey];
  if (!layout) throw new Error("Measured lifecycle workspace has no persisted layout");
  const ordinaryPaneIds = snapshot.children.flatMap((child) => child.paneIds);
  const ordinary = new Set(ordinaryPaneIds);
  const explorerIds = snapshot.fullChildIds.filter((id) => !ordinary.has(id));
  expect(explorerIds).toHaveLength(1);
  const explorerId = explorerIds[0];
  const explorerIndex = snapshot.fullChildIds.indexOf(explorerId);
  return {
    workspaceKey: snapshot.workspaceKey,
    groupId: snapshot.groupId,
    ordinaryPaneIds,
    fullChildIds: snapshot.fullChildIds,
    explorerId,
    explorerFraction: snapshot.layoutSizes[explorerIndex],
    persistentTabs: collectAllTabs(layout.root)
      .filter((tab) => tab.target.kind !== "new_tab")
      .map((tab) => ({ tabId: tab.tabId, target: tab.target })),
  };
}

async function expectDividersTrackPointer(
  page: Page,
  distance = DRAG_DISTANCE,
  drag = dragDivider,
): Promise<void> {
  for (const index of [0, 1, 2]) {
    const divider = splitDividers(page).nth(index);
    const before = await dividerX(divider);
    const evidence: DividerEvidence = {
      requestedDelta: distance,
      before: await dividerSnapshot(divider),
    };
    const input = await captureDividerInput(page);
    try {
      await drag(divider, distance, async () => {
        evidence.preview = await dividerSnapshot(divider);
      });
      evidence.committed = await dividerSnapshot(divider);
      await expect
        .poll(async () => Math.abs((await dividerX(divider)) - before - distance), {
          message: `divider ${index + 1} should stay under the pointer`,
        })
        .toBeLessThanOrEqual(TOLERANCE_PX);
    } finally {
      evidence.input = await input.evaluate((capture) => capture.events);
      const pointerStart = evidence.input.find((event) => event.type === "pointerdown");
      const pointerEvents = evidence.input.filter(
        (event) => event.pointerId === pointerStart?.pointerId,
      );
      const pointerEnd = pointerEvents[pointerEvents.length - 1];
      await input.evaluate((capture) => capture.stop());
      await input.dispose();
      await test.info().attach(`split-divider-${index + 1}-${distance}`, {
        body: Buffer.from(
          JSON.stringify(
            {
              ...evidence,
              actualSignedDelta: evidence.committed ? evidence.committed.dividerX - before : null,
              actualPointerDelta:
                pointerStart && pointerEnd
                  ? {
                      x: pointerEnd.clientX - pointerStart.clientX,
                      y: pointerEnd.clientY - pointerStart.clientY,
                    }
                  : null,
            },
            null,
            2,
          ),
        ),
        contentType: "application/json",
      });
    }
  }
}

for (const hasTouch of [false, true]) {
  test.describe(`Split pane drag tracking (${hasTouch ? "coarse" : "fine"} pointer)`, () => {
    test.use({ hasTouch });

    test("a divider moves as far as the pointer in the main row", async ({ page }) => {
      await page.setViewportSize({ width: 1600, height: 900 });
      const workspace = await seedWorkspace({ repoPrefix: "split-drag-tracking-" });
      try {
        await gotoWorkspace(page, workspace.workspaceId);
        await waitForWorkspaceTabsVisible(page);
        await clickNewChat(page);
        await splitIntoFourPanes(page);
        await expectDividersTrackPointer(
          page,
          DRAG_DISTANCE,
          hasTouch ? dragDividerWithTouch : dragDivider,
        );
      } finally {
        await workspace.cleanup();
      }
    });

    test("dividers track the pointer after app creation, Explorer changes and reload", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1600, height: 900 });
      const creation = await createCreationScenario(page);
      try {
        await creation.openWorkspaceForm("local");
        await creation.submitPrompt("Reply briefly.", "Create");
        await creation.expectAssistantReply();
        await waitForWorkspaceTabsVisible(page);
        await splitIntoBalancedFourPanes(page);
        const identities = await splitLifecycleIdentity(page);
        await expectDividersTrackPointer(page, DRAG_DISTANCE, dragUnclampedDivider);
        expect(await splitLifecycleIdentity(page)).toEqual(identities);
        await page
          .getByTestId("workspace-explorer-toggle")
          .filter({ visible: true })
          .first()
          .click();
        await expect(page.getByTestId("workspace-explorer-sidebar")).toBeVisible();
        expect(await splitLifecycleIdentity(page)).toEqual(identities);
        await expectDividersTrackPointer(page, -DRAG_DISTANCE, dragUnclampedDivider);
        expect(await splitLifecycleIdentity(page)).toEqual(identities);
        await page
          .getByTestId("workspace-explorer-toggle")
          .filter({ visible: true })
          .first()
          .click();
        await expect(page.getByTestId("workspace-explorer-sidebar")).not.toBeVisible();
        expect(await splitLifecycleIdentity(page)).toEqual(identities);
        await page.reload();
        await expect(splitDividers(page)).toHaveCount(3);
        expect(await splitLifecycleIdentity(page)).toEqual(identities);
        await expectDividersTrackPointer(page, DRAG_DISTANCE, dragUnclampedDivider);
        expect(await splitLifecycleIdentity(page)).toEqual(identities);
      } finally {
        await creation.cleanup();
      }
    });
  });
}
