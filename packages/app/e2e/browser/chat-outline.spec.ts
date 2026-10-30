import { openSettingsSection } from "../support/helpers/settings";
import {
  captureVisibleActualPrompt,
  expectMatchingPromptInk,
  expectActualTextIdentity,
  expectActualSingleLineGeometry,
  expectActualExpandedGeometry,
  expectActualRowUnpinned,
  expectActualFindVisible,
  expectSingleLineStickyGeometry,
} from "../support/helpers/sticky-preview-geometry";
import { observePromptPointer } from "../support/helpers/prompt-pointer-observation";
import type { JSHandle, Locator, Page, TestInfo } from "@playwright/test";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { expect, test } from "../support/fixtures";
import { expectNearBottom } from "../support/helpers/agent-bottom-anchor";
import { fillComposerDraft, expectComposerDraft, submitMessage } from "../support/helpers/composer";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import {
  trackPromptJumpRequests,
  holdAgentOlderTimelinePages,
  type TimelineWindowPageReceipt,
} from "../support/helpers/agent-timeline-gate";
import {
  clickChatOutlineRowEdge,
  disableChatOutlineFromAppearance,
  expectActiveChatOutlinePrompt,
  expectActiveChatOutlinePromptMovedFrom,
  expectChatOutlinePreview,
  expectChatOutlinePrompts,
  expectChatOutlinePromptToRemainBare,
  expectLiveTurnPromptAboveFoldAndActive,
  expectNoChatOutlinePreviewWhileCrossingToSidebar,
  expectNoChatOutline,
  expectNoChatOutlinePreview,
  expectOneActiveChatOutlinePrompt,
  focusChatOutlinePrompt,
  hoverChatOutlinePrompt,
  chatOutlineRail,
  movePointerOffChatOutline,
  observePromptIndexRequests,
  pointAtChatOutlineRowEdge,
  pressEnterOnFocusedPrompt,
  splitCurrentPanelRight,
  withStreamingMarkdownOutline,
  expectReadingStreamedMarkdown,
} from "../support/helpers/chat-outline";
import { createCreationScenario } from "../support/helpers/creation";
import {
  attachPromptTimelineEvidence,
  expectPromptsDrawnByPlugin,
  expectVirtualizedPluginPromptVisible,
  withPromptTimelinePlugin,
} from "../support/helpers/plugin-timeline";
import {
  revealUserMessageBody,
  expectTimelineAtMaximumScrollWithPromptVisible,
  expectTimelinePromptNotMounted,
  expectTimelinePromptLandedBelowTop,
  expectTimelinePromptVisible,
  holdOlderHistoryPages,
  openAgentTimeline,
  scrollThroughOlderHistoryPages,
  scrollTimelineToNewestLoadedEdge,
  seedLongMockAgentTimeline,
  seedRemoteToolRunTimeline,
  scrollTimelinePastPrompt,
  scrollTimelinePromptIntoView,
  waitForTimelineGeometryToSettle,
  type LongTimelineAgent,
} from "../support/helpers/timeline-pagination";

// Wide enough that the timeline panel clears the rail's MIN_PANEL_WIDTH with room
// to spare. At 1280 the panel measures 960, which sits too close to the threshold
// for chrome-width changes elsewhere to stay out of these tests.
// Keep real response content below the canonical user row; pre-echo fixture output precedes it.
const STICKY_RESPONSE = Array.from(
  { length: 40 },
  (_, index) => `Response paragraph ${index}.`,
).join("\n\n");
const WIDE_VIEWPORT = { width: 1440, height: 900 };
const LOADED_TURNS = 16;

test.describe("desktop chat outline", () => {
  test("keeps the prompt marked while reading split Markdown blocks and after completion", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const prompt = "Explain in several paragraphs.";
    await withStreamingMarkdownOutline(async (agent) => {
      await agent.client.sendAgentMessage(agent.agentId, "Earlier prompt.");
      await agent.client.waitForFinish(agent.agentId, 30_000);
      await page.setViewportSize(WIDE_VIEWPORT);
      await openAgentTimeline(page, agent);
      await agent.client.sendAgentMessage(agent.agentId, prompt);
      await expectChatOutlinePrompts(page, 2);

      await expectReadingStreamedMarkdown(page, prompt);
      await expectActiveChatOutlinePrompt(page, 2);
      await agent.client.waitForFinish(agent.agentId, 30_000);
      await expectActiveChatOutlinePrompt(page, 2);

      await page.reload({ waitUntil: "domcontentloaded" });
      await expectActiveChatOutlinePrompt(page, 2);
      await clickChatOutlineRowEdge(page, 2);
      await expectTimelinePromptLandedBelowTop(page, prompt);
    });
  });

  test("indexes unloaded prompts and jumps with one bounded merged page", async ({ page }) => {
    test.setTimeout(120_000);
    const agent = await seedLongMockAgentTimeline({ turns: 80 });
    try {
      const jumps = await trackPromptJumpRequests(page, agent.agentId);
      await page.setViewportSize(WIDE_VIEWPORT);
      await openAgentTimeline(page, agent);

      const rail = chatOutlineRail(page);
      await expectChatOutlinePrompts(page, 80);
      await expectTimelinePromptNotMounted(page, agent.oldestPrompt);

      await rail.getByRole("tab").nth(39).click();
      await expectTimelinePromptLandedBelowTop(page, agent.prompts[39]);
      await expect.poll(() => jumps.requests()).toHaveLength(1);
      expect(jumps.requests()[0]).toMatchObject({ limit: 40, mergeWindow: true });

      await page.getByTestId("scroll-to-bottom-button").filter({ visible: true }).click();
      await expectTimelinePromptVisible(page, agent.newestPrompt);

      const requestsBeforeLoadedJump = jumps.requests().length;
      await rail.getByRole("tab").last().click();
      await expectTimelinePromptVisible(page, agent.newestPrompt);
      expect(jumps.requests()).toHaveLength(requestsBeforeLoadedJump);

      await rail.getByRole("tab").first().click();
      await expectTimelinePromptVisible(page, agent.oldestPrompt);
      await agent.client.sendAgentMessage(agent.agentId, "live prompt while viewing old history");
      await agent.client.waitForFinish(agent.agentId, 15_000);
      await expectTimelinePromptVisible(page, agent.oldestPrompt);
    } finally {
      await agent.cleanup();
    }
  });

  test("jumps to prompts a timeline plugin draws", async ({ page }) => {
    test.setTimeout(180_000);
    const agent = await seedLongMockAgentTimeline({ turns: 80 });
    try {
      await withPromptTimelinePlugin(async () => {
        await page.setViewportSize(WIDE_VIEWPORT);
        await openAgentTimeline(page, agent);
        await expectChatOutlinePrompts(page, 80);
        await expectPromptsDrawnByPlugin(page);
        await expectTimelinePromptNotMounted(page, agent.prompts[39]);

        // Unloaded, then loaded, then near the newest edge.
        await clickChatOutlineRowEdge(page, 40);
        await expectTimelinePromptLandedBelowTop(page, agent.prompts[39]);
        await attachPromptTimelineEvidence(page, test.info());
        await clickChatOutlineRowEdge(page, 45);
        await expectTimelinePromptLandedBelowTop(page, agent.prompts[44]);
        await clickChatOutlineRowEdge(page, 78);
        await expectTimelineAtMaximumScrollWithPromptVisible(page, agent.prompts[77]);
        await expectPromptsDrawnByPlugin(page);
      });
    } finally {
      await agent.cleanup();
    }
  });

  test("jumps to a loaded virtualized prompt a timeline plugin draws without fetching", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const agent = await seedLongMockAgentTimeline({ turns: 80 });
    const prompt = agent.prompts[29]!;
    try {
      await withPromptTimelinePlugin(async () => {
        const history = await holdOlderHistoryPages(page, agent);
        await page.setViewportSize(WIDE_VIEWPORT);
        await openAgentTimeline(page, agent);
        await expectChatOutlinePrompts(page, 80);
        await scrollThroughOlderHistoryPages(page, 2, history);
        await scrollTimelineToNewestLoadedEdge(page);
        await expectTimelinePromptNotMounted(page, prompt);
        const requestsBeforeJump = history.requestCount();

        await clickChatOutlineRowEdge(page, 30);
        await expectTimelinePromptLandedBelowTop(page, prompt);
        await expectVirtualizedPluginPromptVisible(page, prompt);
        await attachPromptTimelineEvidence(page, test.info());
        expect(history.requestCount()).toBe(requestsBeforeJump);
      }, [prompt]);
    } finally {
      await agent.cleanup();
    }
  });

  test.describe("with the whole conversation loaded", () => {
    let agent: LongTimelineAgent;

    test.beforeAll(async () => {
      test.setTimeout(120_000);
      agent = await seedLongMockAgentTimeline({ turns: LOADED_TURNS });
    });

    test.afterAll(async () => {
      await agent.cleanup();
    });

    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(WIDE_VIEWPORT);
      await openAgentTimeline(page, agent);
      await expectChatOutlinePrompts(page, LOADED_TURNS);
    });

    test("previews the prompt under the pointer, anywhere across its row", async ({ page }) => {
      await hoverChatOutlinePrompt(page, 2);
      await expectChatOutlinePreview(page, agent.prompts[1]);

      await pointAtChatOutlineRowEdge(page, 7);
      await expectChatOutlinePreview(page, agent.prompts[6]);

      await movePointerOffChatOutline(page);
      await expectNoChatOutlinePreview(page);
    });

    test("does not preview while crossing the rail toward the sidebar", async ({ page }) => {
      await expectNoChatOutlinePreviewWhileCrossingToSidebar(page);
    });

    test("closes the preview when the pointer leaves after a jump", async ({ page }) => {
      await clickChatOutlineRowEdge(page, 4);
      await movePointerOffChatOutline(page);

      await expectNoChatOutlinePreview(page);
    });

    test("previews and jumps to the focused prompt from the keyboard", async ({ page }) => {
      await focusChatOutlinePrompt(page, 1);
      await expectChatOutlinePreview(page, agent.prompts[0]);
      await expectTimelinePromptNotMounted(page, agent.oldestPrompt);

      await pressEnterOnFocusedPrompt(page);
      await expectTimelinePromptLandedBelowTop(page, agent.oldestPrompt);
      await expectActiveChatOutlinePrompt(page, 1);
    });

    test("moves the active mark as the reader jumps and scrolls", async ({ page }) => {
      await expectOneActiveChatOutlinePrompt(page);

      await clickChatOutlineRowEdge(page, 4);
      await expectTimelinePromptLandedBelowTop(page, agent.prompts[3]);
      await expectActiveChatOutlinePrompt(page, 4);

      await scrollTimelineToNewestLoadedEdge(page);
      await expectTimelinePromptVisible(page, agent.newestPrompt);
      await expectActiveChatOutlinePromptMovedFrom(page, 4);
    });

    test("keeps a clicked prompt free of persistent selection chrome", async ({ page }) => {
      await clickChatOutlineRowEdge(page, 4);

      await expectChatOutlinePromptToRemainBare(page, 4);
    });

    test("clamps the newest prompt at maximum scroll while keeping it visible", async ({
      page,
    }) => {
      await clickChatOutlineRowEdge(page, LOADED_TURNS);

      await expectTimelineAtMaximumScrollWithPromptVisible(page, agent.newestPrompt);
    });

    test("keeps the current prompt active throughout a long live assistant turn", async ({
      page,
    }) => {
      const prompt = "chat outline live turn reading position";
      await agent.client.sendAgentMessage(agent.agentId, prompt);
      try {
        await expectLiveTurnPromptAboveFoldAndActive(page, prompt, LOADED_TURNS + 1);
      } finally {
        await agent.client.waitForFinish(agent.agentId, 15_000);
      }
    });
  });

  test.describe("with virtualized loaded history", () => {
    let agent: LongTimelineAgent;

    test.beforeAll(async () => {
      test.setTimeout(120_000);
      agent = await seedLongMockAgentTimeline({ turns: 80 });
    });

    test.afterAll(async () => {
      await agent.cleanup();
    });

    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(WIDE_VIEWPORT);
    });

    test("pins a loaded prompt inside the virtualized block without fetching", async ({ page }) => {
      const history = await holdOlderHistoryPages(page, agent);
      await openAgentTimeline(page, agent);
      await expectChatOutlinePrompts(page, 80);
      await scrollThroughOlderHistoryPages(page, 2, history);
      await scrollTimelineToNewestLoadedEdge(page);
      const requestsBeforeJump = history.requestCount();

      await clickChatOutlineRowEdge(page, 30);
      await expectTimelinePromptLandedBelowTop(page, agent.prompts[29]);

      expect(history.requestCount()).toBe(requestsBeforeJump);
    });

    test("pins a newer loaded prompt when jumping downward from old history", async ({ page }) => {
      const history = await holdOlderHistoryPages(page, agent);
      await openAgentTimeline(page, agent);
      await expectChatOutlinePrompts(page, 80);
      await scrollThroughOlderHistoryPages(page, 2, history);
      await scrollTimelineToNewestLoadedEdge(page);

      await clickChatOutlineRowEdge(page, 30);
      await expectTimelinePromptLandedBelowTop(page, agent.prompts[29]);

      await clickChatOutlineRowEdge(page, 60);

      await expectTimelinePromptLandedBelowTop(page, agent.prompts[59]);
    });
  });

  test("hides the rail when a split makes its panel narrow", async ({ page }) => {
    const agent = await seedLongMockAgentTimeline({ turns: 2 });
    try {
      await page.setViewportSize(WIDE_VIEWPORT);
      await openAgentTimeline(page, agent);

      await splitCurrentPanelRight(page);

      await expectNoChatOutline(page);
    } finally {
      await agent.cleanup();
    }
  });

  test("can be disabled from Appearance settings", async ({ page }) => {
    const agent = await seedLongMockAgentTimeline({ turns: 2 });
    try {
      await page.setViewportSize(WIDE_VIEWPORT);
      await openAgentTimeline(page, agent);

      await disableChatOutlineFromAppearance(page);

      await expectNoChatOutline(page);
    } finally {
      await agent.cleanup();
    }
  });
});

test("indexes a new agent's prompts only once the agent exists", async ({ page }) => {
  const promptIndex = await observePromptIndexRequests(page);
  const creation = await createCreationScenario(page);
  try {
    await page.setViewportSize(WIDE_VIEWPORT);
    await creation.openAgentDraft();
    await creation.submitPrompt("Start an agent with an outline.");
    await creation.expectPromptVisible();

    const agentIds = await creation.agentIds();
    expect(agentIds).toHaveLength(1);
    await promptIndex.waitForRequestFor(agentIds[0]!);
    expect(promptIndex.requestedAgentIds()).toEqual(agentIds);
  } finally {
    await creation.cleanup();
  }
});

/** Pinned bodies retain their full natural box. Hover its visible clip without
 * scrollIntoView moving the timeline and changing the arrow's owning row.
 */
async function clickMessageNavigation(message: Locator, testID: string) {
  const hover = await message.evaluate((node) => {
    const row = node.closest<HTMLElement>("[data-actual-prompt-row]");
    if (row?.dataset.promptPinned !== "true") return null;
    const bubble = node.querySelector('[data-testid="user-message-bubble"]')!;
    const clip = node.querySelector('[data-testid="user-message-body-scroll"]')!;
    const viewport = node.closest('[data-testid="agent-chat-scroll"]')!;
    const bounds = [bubble, clip, viewport].map((element) => element.getBoundingClientRect());
    const left = Math.max(...bounds.map((rect) => rect.left));
    const right = Math.min(...bounds.map((rect) => rect.right));
    const top = Math.max(...bounds.map((rect) => rect.top));
    const bottom = Math.min(...bounds.map((rect) => rect.bottom));
    const x = (left + right) / 2;
    const y = (top + bottom) / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      x,
      y,
      width: right - left,
      height: bottom - top,
      owned: hit?.closest("[data-actual-prompt-row]") === row,
      id: row.dataset.historyRowId,
    };
  });
  if (hover) {
    expect(hover.width).toBeGreaterThan(0);
    expect(hover.height).toBeGreaterThan(0);
    expect(hover.owned).toBe(true);
    await message.page().mouse.move(hover.x, hover.y);
    expect(
      await message.evaluate(
        (node) => node.closest<HTMLElement>("[data-actual-prompt-row]")?.dataset.historyRowId,
      ),
    ).toBe(hover.id);
  } else {
    await message.getByTestId("user-message-bubble").hover();
  }
  await message.getByTestId(testID).click();
}

/** Arrow landings use the original bubble coordinate even while its real body is pinned. */
async function expectPinnedPromptLanding(page: Page, prompt: string) {
  const row = actualUserRow(page, prompt);
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute("data-prompt-pinned", "true");
  await expect
    .poll(() =>
      row.evaluate((node) => {
        const viewport = node.closest('[data-testid="agent-chat-scroll"]')!;
        const bubble = node.querySelector('[data-testid="user-message-bubble"]')!;
        const originalTop =
          node.getBoundingClientRect().top +
          bubble.getBoundingClientRect().top -
          node.querySelector<HTMLElement>("[data-actual-prompt-content]")!.getBoundingClientRect()
            .top;
        return Math.abs(originalTop - viewport.getBoundingClientRect().top + 2);
      }),
    )
    .toBeLessThanOrEqual(2);
}

function pinnedActualRow(page: Page) {
  return page
    .getByTestId("agent-chat-scroll")
    .locator('[data-actual-prompt-row][data-prompt-pinned="true"]');
}

/** The approved right overlay has an opaque backing and stays inside the painted bubble. */
async function expectInBubblePromptDisclosure(message: Locator) {
  const text = await message.locator("[data-message-text=true]").boundingBox();
  const disclosure = await message.getByTestId("user-message-disclosure").boundingBox();
  const clip = await message.getByTestId("user-message-body-scroll").boundingBox();
  expect(text).not.toBeNull();
  expect(disclosure).not.toBeNull();
  expect(clip).not.toBeNull();
  expect(disclosure!.x).toBeGreaterThanOrEqual(clip!.x);
  expect(disclosure!.x + disclosure!.width).toBeLessThanOrEqual(clip!.x + clip!.width);
  expect(disclosure!.y).toBeGreaterThanOrEqual(clip!.y);
  expect(disclosure!.y + disclosure!.height).toBeLessThanOrEqual(clip!.y + clip!.height);
  const backing = await message
    .locator('[data-user-message-compact-occlusion="controls"]')
    .evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        bounds: node.getBoundingClientRect().toJSON(),
        allocation: node.parentElement!.getBoundingClientRect().toJSON(),
        color: style.backgroundColor,
        opacity: style.opacity,
        corners: [
          style.borderTopLeftRadius,
          style.borderTopRightRadius,
          style.borderBottomRightRadius,
          style.borderBottomLeftRadius,
        ],
      };
    });
  expect(backing.bounds).toEqual(backing.allocation);
  expect(backing.opacity).toBe("1");
  expect(backing.corners).toEqual(["0px", "0px", "0px", "0px"]);
  expect(backing.color).toMatch(/^rgb\(/);
  expect(backing.color).toBe(
    await message
      .getByTestId("user-message-bubble")
      .evaluate((node) => getComputedStyle(node).backgroundColor),
  );
}

/** Keep pointer observation and original-message landing identical across destination geometries. */
async function expectStationaryPromptLanding(
  page: Page,
  testInfo: TestInfo,
  prior: string,
  origin: "pinned" | "original" = "pinned",
) {
  const newest = `Current response context\n${"A shared-width line keeps the real bubble under the pointer.\n".repeat(8)}`;
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "sticky-stationary-pointer",
    title: "Sticky stationary pointer",
    featureValues: { mockAssistantResponse: STICKY_RESPONSE },
    initialPrompt: "Earlier context",
  });
  try {
    await agent.client.waitForFinish(agent.agentId, 15_000);
    for (const prompt of [prior, newest]) {
      await agent.client.sendAgentMessage(agent.agentId, prompt);
      await agent.client.waitForFinish(agent.agentId, 15_000);
    }
    await page.setViewportSize(WIDE_VIEWPORT);
    await openAgentRoute(page, agent);
    const sticky = pinnedActualRow(page);
    let source: Locator;
    if (origin === "original") {
      // An earlier prompt can remain pinned while this full original is visible below it.
      // Validate this source's pixel ownership rather than banning unrelated sticky context.
      await scrollTimelinePromptIntoView(page, newest);
      source = page
        .getByTestId("agent-chat-scroll")
        .getByTestId("user-message")
        .filter({ hasText: newest });
      // The current one-line default must be expanded to preserve the long-to-short geometry.
      await revealUserMessageBody(source);
    } else {
      await scrollActualRowPastTailHandoff(page, actualUserRow(page, newest));
      await expect(sticky).toContainText("Current response context");
      source = sticky;
    }
    await source.getByTestId("user-message-bubble").hover();
    const previous = source.getByTestId("user-message-previous");
    await expect(previous).toBeEnabled();
    if (origin === "original") {
      await expect(source.getByTestId("user-message-bubble")).toBeInViewport({ ratio: 1 });
      const sourceControls = source.getByTestId("user-message-trailing-row");
      await expect(sourceControls).not.toHaveAttribute("aria-hidden", "true");
      await expect(sourceControls).toHaveCSS("opacity", "1");
      await expect(sourceControls).toHaveCSS("pointer-events", "auto");
      const uncovered = await previous.evaluate((button) => {
        const rect = button.getBoundingClientRect();
        const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        const hit = document.elementFromPoint(point.x, point.y);
        return { point, hitInsideControl: hit !== null && button.contains(hit) };
      });
      await testInfo.attach("original-source-before-click", {
        body: JSON.stringify(uncovered, null, 2),
        contentType: "application/json",
      });
      await page.screenshot({ path: testInfo.outputPath("original-source-before-click.png") });
      expect(uncovered.hitInsideControl).toBe(true);
    }
    const observation = await observePromptPointer(previous);
    try {
      // This is the last pointer-driving action. Landing and observation cannot move it.
      await previous.click();
      await expectPinnedPromptLanding(page, prior);
      await waitForTimelineGeometryToSettle(page);
      const original = actualUserRow(page, prior);
      await expect(original).toHaveCount(1);
      const controls = original.getByTestId("user-message-trailing-row");
      const pointer = await observation.read(original);
      const observed = {
        ...pointer,
        origin,
        ownership: {
          pinnedRows: await sticky.count(),
          originalAriaHidden: await original.getAttribute("aria-hidden"),
          previousDisabled: await controls
            .getByTestId("user-message-previous")
            .getAttribute("aria-disabled"),
        },
      };
      await testInfo.attach("stationary-pointer-landing", {
        body: JSON.stringify(observed, null, 2),
        contentType: "application/json",
      });
      await page.screenshot({ path: testInfo.outputPath("stationary-pointer-landing.png") });
      expect(observed.movesAfterClick).toBe(0);
      await expect(sticky).toHaveCount(1);
      await expect(controls.getByTestId("user-message-previous")).toBeEnabled();
      // The actual row retains its rewind, copy and both navigation actions.
      await expect(controls.getByRole("button")).toHaveCount(4);
      await expect(controls.getByRole("button", { name: "Copy message", exact: true })).toHaveCount(
        1,
      );
      await expect(
        controls.getByRole("button", { name: "Previous user message", exact: true }),
      ).toHaveCount(1);
      await expect(
        controls.getByRole("button", { name: "Next user message", exact: true }),
      ).toHaveCount(1);
      await expect(
        controls.getByRole("button", { name: "Rewind to this message", exact: true }),
      ).toHaveCount(1);
      if (origin === "original") {
        // This approved visibility hold is separate from hover: the causal fixture's
        // stationary point stays below the short destination after the real jump.
        expect(observed.hitInsideHoverWrapper).toBe(false);
        expect(observed.wrapperHovered).toBe(false);
        expect(observed.trailingOpacity).toBe("1");
        expect(observed.trailingPointerEvents).toBe("auto");
        await expect(controls).not.toHaveAttribute("aria-hidden", "true");

        if (!observed.point)
          throw new Error("The original arrow click has no recorded pointer point");
        await page.mouse.move(observed.point.x + 1, observed.point.y);
        await expect(controls).toHaveCSS("opacity", "0");
        await expect(controls).toHaveCSS("pointer-events", "none");
        await page.screenshot({ path: testInfo.outputPath("destination-after-mouse-move.png") });
        const bubble = (await original.getByTestId("user-message-bubble").boundingBox())!;
        await page.mouse.move(bubble.x + bubble.width / 2, bubble.y + bubble.height / 2);
        await expect(controls).toHaveCSS("opacity", "1");
        await expect(controls).toHaveCSS("pointer-events", "auto");
        await page.mouse.move(20, 20);
        await expect(controls).toHaveCSS("opacity", "0");
        return;
      }
      // A failed hit/hover precondition distinguishes destination geometry from stale React state.
      expect(observed.hitInsideOriginal).toBe(true);
      expect(observed.hitInsideHoverWrapper).toBe(true);
      expect(observed.wrapperHovered).toBe(true);
      expect(observed.trailingOpacity).toBe("1");
      expect(observed.trailingPointerEvents).toBe("auto");
      await expect(controls).not.toHaveAttribute("aria-hidden", "true");
      await expect(controls).toHaveCSS("opacity", "1");
      await expect(controls).toHaveCSS("pointer-events", "auto");
    } catch (error) {
      const snapshot = await observation.snapshot();
      await testInfo.attach("stationary-pointer-before-failure", {
        body: JSON.stringify(snapshot, null, 2),
        contentType: "application/json",
      });
      await page.screenshot({ path: testInfo.outputPath("stationary-pointer-before-failure.png") });
      throw error;
    } finally {
      await observation.dispose();
    }
  } finally {
    await agent.cleanup();
  }
}

// Keep the previously passing long case, but do not rerun it for the new short-destination probe.
test("previous prompt preserves actual hover under a stationary pointer after landing", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await expectStationaryPromptLanding(
    page,
    testInfo,
    `Previous response context\n${"A shared-width line keeps the real bubble under the pointer.\n".repeat(8)}`,
  );
});

for (const destination of [
  { name: "short", prompt: "Short." },
  { name: "one-line", prompt: "One line with enough width to hold the navigation landing." },
  { name: "multiline", prompt: "First line\nSecond line" },
]) {
  test(`stationary pointer controls after previous ${destination.name} prompt`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    await expectStationaryPromptLanding(page, testInfo, destination.prompt);
  });
}

test("consecutive pinned previous arrows preserve the second real click without mouse movement", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const oldest = "Oldest destination.";
  const middle = "Middle destination.";
  const newest = `Newest destination\n${"Loaded context for the pinned arrow sequence.\n".repeat(8)}`;
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "sticky-consecutive-arrows",
    title: "Consecutive pinned arrows",
    featureValues: { mockAssistantResponse: STICKY_RESPONSE },
    initialPrompt: oldest,
  });
  try {
    await agent.client.waitForFinish(agent.agentId, 15_000);
    for (const prompt of [middle, newest]) {
      await agent.client.sendAgentMessage(agent.agentId, prompt);
      await agent.client.waitForFinish(agent.agentId, 15_000);
    }
    await page.setViewportSize(WIDE_VIEWPORT);
    await openAgentRoute(page, agent);
    await scrollActualRowPastTailHandoff(page, actualUserRow(page, newest));
    const pinned = pinnedActualRow(page);
    await expect(pinned).toContainText("Newest destination");
    await pinned.getByTestId("user-message-bubble").hover();
    const first = pinned.getByTestId("user-message-previous");
    const observation = await observePromptPointer(first);
    try {
      await first.click();
      await expectPinnedPromptLanding(page, middle);
      await waitForTimelineGeometryToSettle(page);
      const replacement = actualUserRow(page, middle);
      const beforeSecond = await observation.read(replacement);
      await testInfo.attach("replacement-before-second-click", {
        body: JSON.stringify(beforeSecond, null, 2),
        contentType: "application/json",
      });
      await page.screenshot({ path: testInfo.outputPath("replacement-before-second-click.png") });
      expect(beforeSecond.movesAfterClick).toBe(0);
      const next = replacement.getByTestId("user-message-previous");
      await expect(next).toBeEnabled();
      const point = beforeSecond.point;
      if (!point) throw new Error("The first pinned arrow did not record a real pointer point");
      const hit = await next.evaluate((button, clickPoint) => {
        const target = document.elementFromPoint(clickPoint.x, clickPoint.y);
        return target !== null && button.contains(target);
      }, point);
      expect(hit).toBe(true);
      // Press at the identical stationary point. Locator.click would be allowed to move it.
      await page.mouse.down();
      await page.mouse.up();
      await waitForTimelineGeometryToSettle(page);
      const destination = actualUserRow(page, oldest);
      const afterSecond = await observation.read(destination);
      await testInfo.attach("after-second-click", {
        body: JSON.stringify(afterSecond, null, 2),
        contentType: "application/json",
      });
      await page.screenshot({ path: testInfo.outputPath("after-second-click.png") });
      expect(afterSecond.movesAfterClick).toBe(0);
      expect(afterSecond.actions.filter((event) => event.type === "pointerdown")).toHaveLength(2);
      expect(afterSecond.actions.every((event) => event.trusted)).toBe(true);
      await expectPinnedPromptLanding(page, oldest);
      await expect(pinned.getByTestId("user-message-next")).toBeEnabled();
      await expect(pinned.getByTestId("user-message-trailing-row")).toHaveCSS("opacity", "1");
      // Clicking the content keeps its distinct original-message reveal behavior.
      await destination
        .getByTestId("user-message-content-target")
        .click({ position: { x: 10, y: 4 } });
      await expectTimelinePromptLandedBelowTop(page, oldest);
    } catch (error) {
      await testInfo.attach("consecutive-click-before-failure", {
        body: JSON.stringify(await observation.snapshot(), null, 2),
        contentType: "application/json",
      });
      await page.screenshot({ path: testInfo.outputPath("consecutive-click-before-failure.png") });
      throw error;
    } finally {
      await observation.dispose();
    }
  } finally {
    await agent.cleanup();
  }
});

test("original previous arrow observes stationary pointer ownership after landing", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await expectStationaryPromptLanding(page, testInfo, "Short.", "original");
});

function actualUserRow(page: Page, prompt: string) {
  return page
    .getByTestId("agent-chat-scroll")
    .locator("[data-actual-prompt-row]")
    .filter({ hasText: prompt });
}

/** Setup uses published natural/compact geometry; the independent browser
 * boundary case remains the oracle for the handoff itself.
 */
function actualRowTailHandoffDistance(node: Element): number | null {
  const viewport = node.closest('[data-testid="agent-chat-scroll"]');
  const body = node.querySelector("[data-actual-prompt-content]");
  const flow = Number(body?.getAttribute("data-prompt-flow-height"));
  const compact = Number(body?.getAttribute("data-prompt-compact-height"));
  if (
    !viewport ||
    !body ||
    !Number.isFinite(flow) ||
    !Number.isFinite(compact) ||
    flow <= 0 ||
    compact <= 0
  ) {
    return null;
  }
  return (
    node.getBoundingClientRect().top -
    viewport.getBoundingClientRect().top +
    Math.max(0, flow - compact)
  );
}

async function scrollActualRowPastTailHandoff(page: Page, row: Locator) {
  const timeline = page.getByTestId("agent-chat-scroll");
  await timeline.hover();
  await expect.poll(() => row.evaluate(actualRowTailHandoffDistance)).not.toBeNull();
  const distance = await row.evaluate(actualRowTailHandoffDistance);
  if (distance === null)
    throw new Error("The actual prompt has no qualified tail handoff geometry");
  await page.mouse.wheel(0, distance + 1);
  await expect
    .poll(() =>
      row.evaluate(function originalRowOffset(node) {
        const top = node.closest('[data-testid="agent-chat-scroll"]')!.getBoundingClientRect().top;
        return node.getBoundingClientRect().top - top;
      }),
    )
    .toBeLessThan(0);
  await expect(row).toHaveAttribute("data-prompt-pinned", "true");
}

test("actual user row preserves node identity while pinning and restores disclosure after settings", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const prompt = "Actual row identity\nSecond rendered line\nThird rendered line";
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "actual-row-identity",
    title: "Actual row identity",
    initialPrompt: prompt,
  });
  try {
    await agent.client.waitForFinish(agent.agentId, 15_000);
    await agent.client.sendAgentMessage(
      agent.agentId,
      "emit 85 assistant messages before synthetic user message",
    );
    await agent.client.waitForFinish(agent.agentId, 15_000);
    await page.setViewportSize(WIDE_VIEWPORT);
    await openAgentRoute(page, agent);
    const entry = chatOutlineRail(page).getByRole("tab", { name: /Actual row identity/ });
    await expect(entry).toHaveCount(1);
    await entry.click();
    await expectTimelinePromptLandedBelowTop(page, prompt);
    const row = actualUserRow(page, prompt);
    await expect(row).toHaveCount(1);
    await page.getByTestId("agent-chat-scroll").hover();
    await expectActualRowUnpinned(page, row, testInfo);
    const wrapper = await row.elementHandle();
    const text = await row.getByTestId("user-message-text").elementHandle();
    expect(wrapper).not.toBeNull();
    expect(text).not.toBeNull();
    await expectActualExpandedGeometry(row, "prepared-hidden");
    await expectSinglePaintedPromptHandoff({
      page,
      prompt,
      width: WIDE_VIEWPORT.width,
      disclosure: "more",
    });
    await scrollActualRowPastTailHandoff(page, row);
    await expect(row).toHaveAttribute("data-prompt-pinned", "true");
    expect(await row.evaluate((node, prior) => node === prior, wrapper!)).toBe(true);
    await expectActualTextIdentity(row, text!, prompt);
    const disclosure = row.getByTestId("user-message-disclosure");
    await disclosure.click();
    await expect(disclosure).toHaveAttribute("aria-expanded", "true");
    await expectActualTextIdentity(row, text!, prompt);
    await disclosure.click();
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await expectActualSingleLineGeometry(row);
    await expectActualTextIdentity(row, text!, prompt);
    // Settings is an app-wide route, not a workspace pane. Do not claim that
    // navigating away and returning preserves the previous route's DOM nodes.
    await page.getByTestId("sidebar-settings").click();
    await openSettingsSection(page, "paseo-plus-plus");
    const toggle = page.getByTestId("paseo-plus-plus-stickyUserPrompts").getByRole("switch");
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await openAgentRoute(page, agent);
    await chatOutlineRail(page)
      .getByRole("tab", { name: /Actual row identity/ })
      .click();
    await expectTimelinePromptLandedBelowTop(page, prompt);
    const returned = actualUserRow(page, prompt);
    await expect(returned.getByTestId("user-message-disclosure")).toHaveCount(0);
    await page.getByTestId("sidebar-settings").click();
    await openSettingsSection(page, "paseo-plus-plus");
    await toggle.click();
    await expect(toggle).toBeChecked();
    await openAgentRoute(page, agent);
    await chatOutlineRail(page)
      .getByRole("tab", { name: /Actual row identity/ })
      .click();
    await expectTimelinePromptLandedBelowTop(page, prompt);
    await expectActualExpandedGeometry(actualUserRow(page, prompt), "prepared-hidden");
  } finally {
    await agent.cleanup();
  }
});

test("actual user row find expands each occurrence and preserves its text node", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const prompt = `Actual find ownership\n${"padding content for inner scrolling\n".repeat(65)}deep-actual-needle first\n${"more padding\n".repeat(65)}deep-actual-needle second`;
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "actual-row-find",
    title: "Actual row find",
    initialPrompt: prompt,
  });
  try {
    await agent.client.waitForFinish(agent.agentId, 15_000);
    await agent.client.sendAgentMessage(
      agent.agentId,
      "emit 85 assistant messages before synthetic user message",
    );
    await agent.client.waitForFinish(agent.agentId, 15_000);
    await page.setViewportSize(WIDE_VIEWPORT);
    await openAgentRoute(page, agent);
    const entry = chatOutlineRail(page).getByRole("tab", { name: /Actual find ownership/ });
    await expect(entry).toHaveCount(1);
    await entry.click();
    await expectTimelinePromptLandedBelowTop(page, prompt);
    const row = actualUserRow(page, prompt);
    await expectActualExpandedGeometry(row, "prepared-hidden");
    const text = await row.getByTestId("user-message-text").elementHandle();
    expect(text).not.toBeNull();
    await scrollActualRowPastTailHandoff(page, row);
    await expect(row).toHaveAttribute("data-prompt-pinned", "true");
    // Use the existing app shortcut; Find exposes the full original body,
    // independently of explicit pinned More/Less disclosure.
    // Pinned metadata is deliberately pointer-disabled; focus the owning transcript itself.
    await page.getByTestId("agent-chat-scroll").focus();
    await page.keyboard.press("ControlOrMeta+f");
    const panel = page.locator('[data-chat-find-widget="true"]').filter({ visible: true });
    const query = panel.getByRole("textbox", { name: "Find in pane", exact: true });
    await expect(query).toBeFocused();
    await query.fill("deep-actual-needle");
    await expect(panel.getByRole("status", { name: "Find matches" })).toHaveText("1 of 2");
    const disclosure = row.getByTestId("user-message-disclosure");
    await expect(disclosure).toHaveCount(0);
    const firstOccurrence = await expectActualFindVisible(
      row,
      prompt.indexOf("deep-actual-needle"),
    );
    await expectActualTextIdentity(row, text!, prompt);
    await query.press("Enter");
    await expect(panel.getByRole("status", { name: "Find matches" })).toHaveText("2 of 2");
    await expect(disclosure).toHaveCount(0);
    const secondOccurrence = await expectActualFindVisible(
      row,
      prompt.lastIndexOf("deep-actual-needle"),
    );
    expect(secondOccurrence).not.toBe(firstOccurrence);
    await expectActualTextIdentity(row, text!, prompt);
    // Supersede a reveal and close using real UI. No late write may reopen the body.
    await query.fill("deep-actual-needle first");
    await query.press("Escape");
    await expect(query).toHaveCount(0);
    // Find's selected generation has now been released. Re-establish the real
    // original landing and pin before exercising explicit bounded disclosure.
    await entry.click();
    await expectTimelinePromptLandedBelowTop(page, prompt);
    await scrollActualRowPastTailHandoff(page, row);
    await expect(row).toHaveAttribute("data-prompt-pinned", "true");
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await disclosure.click();
    await expect(disclosure).toHaveAttribute("aria-expanded", "true");
    await disclosure.click();
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    // One finite observation, never retried: any sampled reopen is retained as failure.
    const settledStates = await row.evaluate(async (node) => {
      const states: string[] = [];
      for (let frame = 0; frame < 24; frame++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        states.push(
          node
            .querySelector('[data-testid="user-message-disclosure"]')!
            .getAttribute("aria-expanded")!,
        );
      }
      return states;
    });
    expect(settledStates).toEqual(Array.from({ length: 24 }, () => "false"));
    await expectActualTextIdentity(row, text!, prompt);
    await page.screenshot({ path: testInfo.outputPath("actual-row-find.png") });
  } finally {
    await agent.cleanup();
  }
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`sticky preview discloses only rendered overflow at ${viewport.width}px`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    const prompts = [
      "Short prompt.",
      "First line\nSecond line",
      "**Heading**\n  indented `code`\nThird rendered line",
      `Long preview\n${"  actual content and whitespace\n".repeat(60)}END OF FULL PREVIEW`,
    ];
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "sticky-preview",
      title: "Sticky overflow",
      featureValues: { mockAssistantResponse: STICKY_RESPONSE },
      initialPrompt: prompts[0],
    });
    try {
      await agent.client.waitForFinish(agent.agentId, 15_000);
      for (const prompt of prompts.slice(1)) {
        await agent.client.sendAgentMessage(agent.agentId, prompt);
        await agent.client.waitForFinish(agent.agentId, 15_000);
      }
      await agent.client.sendAgentMessage(agent.agentId, "Final response context");
      await agent.client.waitForFinish(agent.agentId, 15_000);
      // The outline rail is deliberately hidden on compact panes. Bootstrap the
      // route at desktop width, then navigate through the shared arrows after resizing.
      await page.setViewportSize(WIDE_VIEWPORT);
      await page.emulateMedia({ colorScheme: viewport.width === 390 ? "dark" : "light" });
      await openAgentRoute(page, agent);
      await expect(chatOutlineRail(page).getByRole("tab")).toHaveCount(5);
      await page.setViewportSize(viewport);
      const initialCopy = pinnedActualRow(page);
      await expect(initialCopy).toContainText("Final response context");
      for (let index = prompts.length - 1; index >= 0; index -= 1) {
        await clickMessageNavigation(initialCopy, "user-message-previous");
        await expectPinnedPromptLanding(page, prompts[index]!);
      }
      const timeline = page.getByTestId("agent-chat-scroll");
      const original = timeline.getByTestId("user-message").filter({ hasText: prompts[0]! });
      const realHeight = (await original.getByTestId("user-message-bubble").boundingBox())!.height;
      await expectSinglePaintedPromptHandoff({
        page,
        prompt: prompts[0]!,
        width: viewport.width,
        disclosure: "none",
      });
      await scrollTimelinePastPrompt(page, prompts[0]!);
      const sticky = pinnedActualRow(page);
      const shortRow = actualUserRow(page, prompts[0]!);
      const shortDisclosure = shortRow.getByTestId("user-message-disclosure");
      await expect(shortDisclosure).toHaveCount(0);
      await expect(sticky).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(sticky.locator("svg linearGradient")).toHaveCount(0);
      await expect(shortRow.getByTestId("user-message-bubble")).toHaveCSS(
        "border-top-left-radius",
        "0px",
      );
      const latestButton = page.getByTestId("scroll-to-bottom-button");
      await expect(latestButton).toBeVisible();
      const composer = page.getByTestId("message-input-root").filter({ visible: true });
      await expect(composer).toHaveCount(1);
      const composerBounds = (await composer.boundingBox())!;
      const latestBounds = (await latestButton.boundingBox())!;
      expect(latestBounds.x + latestBounds.width).toBeCloseTo(
        composerBounds.x + composerBounds.width,
        0,
      );
      expect(latestBounds.y + latestBounds.height).toBeLessThanOrEqual(composerBounds.y);
      expect((await shortRow.getByTestId("user-message-bubble").boundingBox())!.height).toBeCloseTo(
        realHeight,
        0,
      );
      const shortGeometry = await expectSingleLineStickyGeometry(shortRow);
      await page.screenshot({
        path: `../../docs/qa-evidence/sticky-user-message/short-preview-${viewport.width}.png`,
      });
      for (let index = 1; index < prompts.length; index += 1) {
        await clickMessageNavigation(sticky, "user-message-next");
        await expectPinnedPromptLanding(page, prompts[index]!);
        const selected = actualUserRow(page, prompts[index]!);
        const disclosure = selected.getByTestId("user-message-disclosure");
        await expect(disclosure).toHaveText("more…");
        await expectInBubblePromptDisclosure(selected);
        const longGeometry = await expectSingleLineStickyGeometry(selected);
        expect(longGeometry.height).toBeCloseTo(shortGeometry.height, 0);
        expect(longGeometry.controlsOffset).toBeCloseTo(shortGeometry.controlsOffset, 0);
        const stablePreview = await selected.evaluate(async (node) => {
          const text = node.querySelector('[data-testid="user-message-text"]')!;
          const clip = text.closest('[data-testid="text-preview-clip"]')!;
          const button = node.querySelector('[data-testid="user-message-disclosure"]')!;
          const lineHeight = Number.parseFloat(getComputedStyle(text).lineHeight);
          const height = clip.getBoundingClientRect().height;
          for (let frame = 0; frame < 24; frame += 1) {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            if (
              !text.isConnected ||
              !clip.isConnected ||
              !button.isConnected ||
              clip.getBoundingClientRect().height !== height
            )
              return { stable: false, height, lineHeight };
          }
          return { stable: true, height, lineHeight };
        });
        expect(stablePreview.stable).toBe(true);
        expect(stablePreview.height).toBeLessThanOrEqual(stablePreview.lineHeight + 0.5);
        const collapsed = (await selected.getByTestId("user-message-bubble").boundingBox())!.height;
        await disclosure.focus();
        await disclosure.press("Enter");
        await expect(disclosure).toHaveText("less…");
        await expect(selected.getByTestId("text-preview-measurement")).toHaveCount(0);
        await expect(selected.getByTestId("user-message")).toContainText(prompts[index]!);
        await disclosure.click();
        await expect(disclosure).toHaveText("more…");
        await expect
          .poll(
            async () => (await selected.getByTestId("user-message-bubble").boundingBox())!.height,
          )
          .toBe(collapsed);
      }
      // Put real conversation text behind the pinned copy for the appearance capture.
      await timeline.hover();
      await page.mouse.wheel(0, 100);
      await expect(sticky).toContainText("Long preview");
      await page.screenshot({
        path: `../../docs/qa-evidence/sticky-user-message/overflow-preview-${viewport.width}.png`,
      });
    } catch (error) {
      // Capture the still-owned conversation before agent cleanup can remove its route.
      try {
        const geometry = await page.evaluate(() => {
          const sticky = document.querySelector(
            '[data-actual-prompt-row][data-prompt-pinned="true"]',
          );
          const selectors = [
            '[data-testid="user-message-bubble"]',
            '[data-testid="user-message-text"]',
            '[data-testid="user-message-trailing-row"]',
            '[data-testid="user-message-disclosure"]',
            "[data-message-text=true]",
          ];
          return {
            url: location.href,
            viewport: { width: innerWidth, height: innerHeight },
            nodes: selectors.map((selector) => {
              const node = sticky?.querySelector(selector);
              if (!node) return { selector, present: false };
              const style = getComputedStyle(node);
              return {
                selector,
                present: true,
                bounds: node.getBoundingClientRect().toJSON(),
                parentBounds: node.parentElement?.getBoundingClientRect().toJSON(),
                lineHeight: style.lineHeight,
                paddingTop: style.paddingTop,
                paddingBottom: style.paddingBottom,
                opacity: style.opacity,
                pointerEvents: style.pointerEvents,
              };
            }),
          };
        });
        await testInfo.attach("preview-failure-geometry", {
          body: JSON.stringify(geometry, null, 2),
          contentType: "application/json",
        });
      } catch (captureError) {
        console.error("preview geometry capture failed before cleanup", String(captureError));
      }
      try {
        await page.screenshot({
          path: testInfo.outputPath("preview-before-cleanup.png"),
          timeout: 2_000,
        });
      } catch (captureError) {
        console.error("preview screenshot capture failed before cleanup", String(captureError));
      }
      throw error;
    } finally {
      await agent.cleanup();
    }
  });

  test(`sticky user message navigation at ${viewport.width}px`, async ({ page }) => {
    test.setTimeout(180_000);
    const agent = await seedLongMockAgentTimeline({
      turns: 20,
      mockAssistantResponse: STICKY_RESPONSE,
    });
    try {
      await page.setViewportSize(viewport);
      await openAgentTimeline(page, agent);
      const sticky = pinnedActualRow(page);
      const previous = sticky.getByTestId("user-message-previous");
      await expectTimelinePromptVisible(page, agent.newestPrompt);
      await expect(page.getByTestId("sticky-user-message")).toHaveCount(0);
      const newestBubble = page
        .getByTestId("agent-chat-scroll")
        .getByTestId("user-message")
        .filter({ hasText: agent.newestPrompt });
      await expect(newestBubble.getByTestId("user-message-next")).toBeDisabled();
      const actionRow = newestBubble.getByTestId("user-message-trailing-row");
      await expect(actionRow.getByTestId("user-message-previous")).toHaveCount(1);
      await expect(actionRow.getByTestId("user-message-next")).toHaveCount(1);
      await expect(
        actionRow.getByRole("button", { name: "Copy message", exact: true }),
      ).toHaveCount(1);
      const actionBounds = await actionRow.boundingBox();
      if (viewport.width === 1440) {
        await page.mouse.move(2, 2);
        await expect
          .poll(() => actionRow.evaluate((node) => getComputedStyle(node).opacity))
          .toBe("0");
        await newestBubble.hover();
      }
      await expect
        .poll(() => actionRow.evaluate((node) => getComputedStyle(node).opacity))
        .toBe("1");
      expect(await actionRow.boundingBox()).toEqual(actionBounds);

      for (let index = agent.prompts.length - 2; index >= 0; index -= 1) {
        const original = page
          .getByTestId("agent-chat-scroll")
          .getByTestId("user-message")
          .filter({ hasText: agent.prompts[index + 1]! });
        if (await sticky.count()) {
          await clickMessageNavigation(sticky, "user-message-previous");
        } else {
          await clickMessageNavigation(original, "user-message-previous");
        }
        const target = page
          .getByTestId("agent-chat-scroll")
          .getByTestId("user-message")
          .filter({ hasText: agent.prompts[index]! });
        await expect(target).toBeInViewport();
        // The newest turns cannot always align at the top because the viewport clamps.
        // Older turns leave enough later content to scroll their original bubble offscreen.
        if (index < agent.prompts.length - 8) {
          await expectPinnedPromptLanding(page, agent.prompts[index]!);
          // Keep the existing original-edge handoff checks through the separate content action.
          await sticky
            .getByTestId("user-message-content-target")
            .click({ position: { x: 10, y: 4 } });
          await expectTimelinePromptLandedBelowTop(page, agent.prompts[index]!);
          if (index === 10) {
            const timeline = page.getByTestId("agent-chat-scroll");
            const viewportBox = await timeline.boundingBox();
            const originalBox = await target.boundingBox();
            await timeline.hover();
            await page.mouse.wheel(0, originalBox!.y - viewportBox!.y + 24);
            await expect(sticky).toBeVisible();
            await expect(target).toBeInViewport();
            await expect
              .poll(() => sticky.evaluate((element) => Number(getComputedStyle(element).opacity)))
              .toBe(1);
            const bubble = await sticky.getByTestId("user-message-bubble").boundingBox();
            const controls = await sticky.getByTestId("user-message-trailing-row").boundingBox();
            expect(controls!.y).toBeGreaterThanOrEqual(bubble!.y + bubble!.height - 1);
            await page.screenshot({
              path: `../../docs/qa-evidence/sticky-user-message/handoff-${viewport.width}.png`,
            });
            await page.mouse.wheel(0, -40);
            await expect(actualUserRow(page, agent.prompts[index]!)).toHaveAttribute(
              "data-prompt-pinned",
              "false",
            );
          }
          await scrollTimelinePastPrompt(page, agent.prompts[index]!);
          if (index === 10) {
            const timeline = page.getByTestId("agent-chat-scroll");
            const newer = timeline
              .getByTestId("user-message")
              .filter({ hasText: agent.prompts[index + 1]! });
            const viewportBox = await timeline.boundingBox();
            const newerBox = await newer.boundingBox();
            await timeline.hover();
            await page.mouse.wheel(0, newerBox!.y - viewportBox!.y - 24);
            await expect(sticky).toContainText(agent.prompts[index]!);
            await expect(newer).toBeInViewport();
            const nextRowId = await actualUserRow(page, agent.prompts[index + 1]!).getAttribute(
              "data-history-row-id",
            );
            expect(nextRowId).not.toBeNull();
            const readCollision = () =>
              actualUserRow(page, agent.prompts[index]!).evaluate((row, expectedNextId) => {
                const collisionViewport = row.closest('[data-testid="agent-chat-scroll"]')!;
                const content = row.querySelector("[data-actual-prompt-content]")!;
                const next = Array.from(
                  collisionViewport.querySelectorAll("[data-actual-prompt-row]"),
                ).find((item) => item.getAttribute("data-history-row-id") === expectedNextId);
                if (!next) throw new Error("Expected the adjacent newer actual prompt row");
                const bounds = content.getBoundingClientRect();
                const viewportBounds = collisionViewport.getBoundingClientRect();
                return {
                  bottom: bounds.bottom,
                  nextTop: next.getBoundingClientRect().top,
                  visibleHeight:
                    Math.min(bounds.bottom, viewportBounds.bottom) -
                    Math.max(bounds.top, viewportBounds.top),
                };
              }, nextRowId);
            await expect.poll(async () => (await readCollision()).visibleHeight).toBeLessThan(40);
            const collision = await readCollision();
            expect(collision.visibleHeight).toBeGreaterThan(0);
            expect(collision.visibleHeight).toBeLessThan(40);
            expect(collision.bottom).toBeLessThanOrEqual(collision.nextTop + 1);
            await expect(sticky.getByTestId("user-message-disclosure")).toHaveCount(
              viewport.width === 1440 ? 0 : 1,
            );
            const visibleNewer = await newer.boundingBox();
            const paintedMessage = await page.evaluate(
              ({ x, y }) =>
                document.elementFromPoint(x, y)?.closest('[data-testid="user-message"]')
                  ?.textContent,
              { x: visibleNewer!.x + visibleNewer!.width / 2, y: visibleNewer!.y + 30 },
            );
            expect(paintedMessage).toContain(agent.prompts[index + 1]!);
            await page.screenshot({
              path: `../../docs/qa-evidence/sticky-user-message/overlap-${viewport.width}.png`,
            });
            await page.mouse.wheel(0, 70);
            await expect(sticky).toContainText(agent.prompts[index + 1]!);
            await page.mouse.wheel(0, -70);
            await expect(sticky).toContainText(agent.prompts[index]!);
            // Collision can leave this row's body fully above the clip while its
            // trailing edge still owns the pin. Restore a painted body before
            // the next iteration asks a real pointer to enter that row.
            await scrollTimelinePastPrompt(page, agent.prompts[index]!);
          }
        }
      }
      await expect(previous).toBeDisabled();
      await clickMessageNavigation(sticky, "user-message-next");
      await expectPinnedPromptLanding(page, agent.prompts[1]!);
      // The bubble returns to itself; the arrows still navigate to adjacent prompts.
      await sticky.getByTestId("user-message-content-target").click({ position: { x: 10, y: 4 } });
      await expectTimelinePromptLandedBelowTop(page, agent.prompts[1]!);
      await expect(actualUserRow(page, agent.prompts[1]!)).toHaveAttribute(
        "data-prompt-pinned",
        "false",
      );
      await scrollTimelinePastPrompt(page, agent.prompts[1]!);
      const messageLink = sticky.getByTestId("user-message-text");
      const textBounds = (await messageLink.boundingBox())!;
      await page.mouse.move(textBounds.x + 4, textBounds.y + textBounds.height / 2);
      await page.mouse.down();
      await page.mouse.move(
        textBounds.x + Math.min(textBounds.width - 4, 80),
        textBounds.y + textBounds.height / 2,
        { steps: 8 },
      );
      await page.mouse.up();
      await expect
        .poll(() => page.evaluate(() => window.getSelection()?.toString().length ?? 0))
        .toBeGreaterThan(0);
      await expect(sticky).toContainText(agent.prompts[1]!);
      await page.evaluate(() => window.getSelection()?.removeAllRanges());
      await expect(messageLink).toHaveAttribute("role", "link");
      await messageLink.focus();
      await messageLink.press("Enter");
      await expectTimelinePromptLandedBelowTop(page, agent.prompts[1]!);
      await expect(actualUserRow(page, agent.prompts[1]!)).toHaveAttribute(
        "data-prompt-pinned",
        "false",
      );
      await scrollTimelinePastPrompt(page, agent.prompts[1]!);
      const longPrompt = `Long sticky prompt\n${"  Preserve this line and whitespace.\n".repeat(60)}END OF STICKY PROMPT: emit 85 assistant messages before synthetic user message`;
      await agent.client.sendAgentMessage(agent.agentId, longPrompt);
      await agent.client.waitForFinish(agent.agentId, 15_000);
      await expect(sticky).toContainText(agent.prompts[1]);
      await page.getByTestId("scroll-to-bottom-button").filter({ visible: true }).click();
      await expect(sticky).toContainText("Long sticky prompt");
      await expectNearBottom(page);
      const longRow = actualUserRow(page, longPrompt);
      const readVisibleBodyHeight = () =>
        longRow.getByTestId("user-message-body-scroll").evaluate((body) => {
          const visibleViewport = body
            .closest('[data-testid="agent-chat-scroll"]')!
            .getBoundingClientRect();
          const bounds = body.getBoundingClientRect();
          return Math.max(
            0,
            Math.min(bounds.bottom, visibleViewport.bottom) -
              Math.max(bounds.top, visibleViewport.top),
          );
        });
      const collapsedVisibleBody = await readVisibleBodyHeight();
      expect(collapsedVisibleBody).toBeGreaterThan(0);
      const paintedMessage = longRow.locator("[data-actual-prompt-content]");
      const collapsed = await paintedMessage.boundingBox();
      expect(collapsed!.height).toBeLessThan(150);
      await longRow.getByRole("button", { name: "Expand user message", exact: true }).click();
      await expect(longRow).toContainText("END OF STICKY PROMPT");
      await expect.poll(readVisibleBodyHeight).toBeGreaterThan(collapsedVisibleBody);
      await expectNearBottom(page);
      const expanded = await paintedMessage.boundingBox();
      expect(expanded!.height).toBeLessThan(viewport.height * 0.6);
      const expandedBody = longRow.getByTestId("user-message-body-scroll");
      const innerOverflow = await expandedBody.evaluate(
        (body) => body.scrollHeight - body.clientHeight,
      );
      expect(innerOverflow).toBeGreaterThan(0);
      await expandedBody.hover();
      await page.mouse.wheel(0, innerOverflow);
      await expect
        .poll(() =>
          expandedBody.evaluate((body) => {
            const text = body.querySelector('[data-testid="user-message-text"]')!;
            const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
            const marker = "END OF STICKY PROMPT";
            let node;
            while ((node = walker.nextNode())) {
              const offset = node.textContent?.indexOf(marker) ?? -1;
              if (offset < 0) continue;
              const range = document.createRange();
              range.setStart(node, offset);
              range.setEnd(node, offset + marker.length);
              const end = range.getBoundingClientRect();
              const bounds = body.getBoundingClientRect();
              const clip = text
                .closest('[data-testid="text-preview-clip"]')!
                .getBoundingClientRect();
              const pane = body
                .closest('[data-testid="agent-chat-scroll"]')!
                .getBoundingClientRect();
              const top = Math.max(bounds.top, clip.top, pane.top, 0);
              const bottom = Math.min(bounds.bottom, clip.bottom, pane.bottom, window.innerHeight);
              const left = Math.max(bounds.left, clip.left, pane.left, 0);
              const right = Math.min(bounds.right, clip.right, pane.right, window.innerWidth);
              return (
                body.scrollTop + body.clientHeight >= body.scrollHeight - 2 &&
                end.width > 0 &&
                end.height > 0 &&
                end.top >= top - 1 &&
                end.bottom <= bottom + 1 &&
                end.left >= left - 1 &&
                end.right <= right + 1
              );
            }
            return false;
          }),
        )
        .toBe(true);
      await expectNearBottom(page);
      await page.screenshot({
        path: `../../docs/qa-evidence/sticky-user-message/expanded-${viewport.width}.png`,
      });
      await longRow.getByRole("button", { name: "Collapse user message", exact: true }).click();
      await expect(longRow.getByTestId("user-message-next")).toBeDisabled();
      await expectNearBottom(page);
      await page.screenshot({
        path: `../../docs/qa-evidence/sticky-user-message/compact-${viewport.width}.png`,
      });
      await fillComposerDraft(page, "Unsent draft survives prompt disclosure");
      await longRow.getByRole("button", { name: "Expand user message", exact: true }).click();
      await longRow.getByRole("button", { name: "Collapse user message", exact: true }).click();
      await expectComposerDraft(page, "Unsent draft survives prompt disclosure");
      await page.setViewportSize({ width: viewport.width, height: 500 });
      await longRow.getByRole("button", { name: "Expand user message", exact: true }).click();
      await expect
        .poll(() =>
          longRow.evaluate((element) => {
            const paneHeight = element
              .closest('[data-testid="sticky-prompt-timeline"]')!
              .getBoundingClientRect().height;
            // The transcript row reserves its natural height while the real body is pinned.
            // The visible presentation, including its controls, must fit the smaller viewport.
            const content = element.querySelector("[data-actual-prompt-content]")!;
            return content.getBoundingClientRect().height / paneHeight;
          }),
        )
        .toBeLessThan(0.8);
      await expectNearBottom(page);
      await longRow.getByRole("button", { name: "Collapse user message", exact: true }).click();
      await page.setViewportSize(viewport);
      await page.reload({ waitUntil: "domcontentloaded" });
      // Reload starts at the latest response; the real pinned prompt reveals itself on compact layouts too.
      const reloadedPrompt = actualUserRow(page, longPrompt);
      await expect(reloadedPrompt).toHaveAttribute("data-prompt-pinned", "true");
      await reloadedPrompt
        .getByTestId("user-message-content-target")
        .click({ position: { x: 10, y: 4 } });
      await expectTimelinePromptLandedBelowTop(page, longPrompt);
      await expect(reloadedPrompt).toHaveCount(1);
    } finally {
      await agent.cleanup();
    }
  });
}

test("sticky user message retains its prompt during index loading and exposes a retryable failure", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const agent = await seedLongMockAgentTimeline({ turns: 2 });
  const gate = await installDaemonWebSocketGate(page);
  try {
    gate.failPromptIndexResponses(agent.agentId);
    gate.holdNextServerMessage("agent.timeline.list_prompts.response");
    await openAgentTimeline(page, agent);
    const sticky = page.getByTestId("sticky-user-message");
    await gate.waitForHeldServerMessage("agent.timeline.list_prompts.response");
    const retainedPrompt = actualUserRow(page, agent.newestPrompt);
    await expect(retainedPrompt).toHaveCount(1);
    await expect(retainedPrompt).toBeVisible();
    await expect(retainedPrompt.getByTestId("user-message-text")).toHaveText(agent.newestPrompt);
    await expect(sticky).toHaveCount(0);
    gate.releaseHeldServerMessage("agent.timeline.list_prompts.response");
    await expect(sticky.getByRole("alert")).toHaveText("Could not load user messages.");
    gate.allowPromptIndexResponses();
    await sticky.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(sticky.getByRole("alert")).toHaveCount(0);
    await expect(sticky).toHaveCount(0);
    await clickMessageNavigation(
      page
        .getByTestId("agent-chat-scroll")
        .getByTestId("user-message")
        .filter({ hasText: agent.newestPrompt }),
      "user-message-previous",
    );
    await expect(
      page
        .getByTestId("agent-chat-scroll")
        .getByTestId("user-message")
        .filter({ hasText: agent.oldestPrompt }),
    ).toBeInViewport();
  } finally {
    await agent.cleanup();
  }
});

/** Observe delivery at the client, beyond the server gate's held-arrival acknowledgement. */
async function observeDeliveredTimelinePages(page: Page) {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    const state = window as unknown as { stickyTimelineResponses: number };
    state.stickyTimelineResponses = 0;
    window.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener("message", (event) => {
          try {
            const envelope = JSON.parse(event.data);
            if ((envelope.message ?? envelope).type === "fetch_agent_timeline_response")
              state.stickyTimelineResponses += 1;
          } catch {
            /* Binary transport frames are unrelated. */
          }
        });
      }
    };
  });
  return {
    count: () =>
      page.evaluate(
        () => (window as unknown as { stickyTimelineResponses: number }).stickyTimelineResponses,
      ),
    async waitFor(count: number) {
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { stickyTimelineResponses: number }).stickyTimelineResponses,
          ),
        )
        .toBeGreaterThanOrEqual(count);
    },
  };
}

test("sticky cancelled older window stays at latest after bottom", async ({ page }) => {
  test.setTimeout(120_000);
  const agent = await seedLongMockAgentTimeline({ turns: 30 });
  const gate = await installDaemonWebSocketGate(page);
  const delivered = await observeDeliveredTimelinePages(page);
  try {
    await page.setViewportSize(WIDE_VIEWPORT);
    await openAgentTimeline(page, agent);
    await expectChatOutlinePrompts(page, 30);
    await chatOutlineRail(page).getByRole("tab").nth(22).click();
    await expectTimelinePromptLandedBelowTop(page, agent.prompts[22]!);
    gate.holdNextServerMessage("fetch_agent_timeline_response");
    await chatOutlineRail(page).getByRole("tab").first().click();
    await gate.waitForHeldServerMessage("fetch_agent_timeline_response");
    await page.getByTestId("scroll-to-bottom-button").filter({ visible: true }).click();
    await expectNearBottom(page);
    const before = await delivered.count();
    gate.releaseHeldServerMessage("fetch_agent_timeline_response");
    await delivered.waitFor(before + 1);
    await expect(pinnedActualRow(page).filter({ hasText: agent.oldestPrompt })).toHaveCount(0);
    await expectNearBottom(page);
    await expectTimelinePromptVisible(page, agent.newestPrompt);
    await expect(page.getByTestId("sticky-user-message")).toHaveCount(0);
  } finally {
    await agent.cleanup();
  }
});

test("sticky composer submission cancels a held older window", async ({ page }) => {
  test.setTimeout(180_000);
  const agent = await seedLongMockAgentTimeline({ turns: 30 });
  const gate = await installDaemonWebSocketGate(page);
  const delivered = await observeDeliveredTimelinePages(page);
  try {
    await page.setViewportSize(WIDE_VIEWPORT);
    await openAgentTimeline(page, agent);
    await expectChatOutlinePrompts(page, 30);
    await chatOutlineRail(page).getByRole("tab").nth(22).click();
    await expectTimelinePromptLandedBelowTop(page, agent.prompts[22]!);
    gate.holdNextServerMessage("fetch_agent_timeline_response");
    await chatOutlineRail(page).getByRole("tab").first().click();
    await gate.waitForHeldServerMessage("fetch_agent_timeline_response");
    const sent = "Composer returns to latest: emit 1 coalesced agent stream updates";
    await submitMessage(page, sent);
    await expectNearBottom(page);
    const before = await delivered.count();
    gate.releaseHeldServerMessage("fetch_agent_timeline_response");
    await delivered.waitFor(before + 1);
    await expect(pinnedActualRow(page).filter({ hasText: agent.oldestPrompt })).toHaveCount(0);
    await agent.client.waitForFinish(agent.agentId, 15_000);
    await expectNearBottom(page);
    await expectTimelinePromptVisible(page, sent);
    await expect(page.getByTestId("sticky-user-message").getByRole("alert")).toHaveCount(0);
  } finally {
    await agent.cleanup();
  }
});

for (const indexed of [true, false]) {
  test(`sticky initial assistant-only pages expose loading, failure and retry (indexed: ${indexed})`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "sticky-discovery-",
      title: "Sticky discovery",
    });
    const gate = await installDaemonWebSocketGate(page);
    const prompt = "emit 85 assistant messages before synthetic user message";
    try {
      await agent.client.sendAgentMessage(agent.agentId, prompt);
      await agent.client.waitForFinish(agent.agentId, 15_000);
      if (indexed) gate.failPromptIndexResponses(agent.agentId);
      else {
        gate.stripPromptIndex();
        gate.failTimelineResponses(agent.agentId, "before");
      }
      gate.holdNextServerMessage(
        indexed ? "agent.timeline.list_prompts.response" : "fetch_agent_timeline_response",
      );
      await page.setViewportSize(WIDE_VIEWPORT);
      await openAgentTimeline(page, agent);
      // Indexed discovery holds the index. Index-free discovery must allow bootstrap
      // before holding/failing the older page, so its first held tail is released here.
      await gate.waitForHeldServerMessage(
        indexed ? "agent.timeline.list_prompts.response" : "fetch_agent_timeline_response",
      );
      if (!indexed) gate.releaseHeldServerMessage("fetch_agent_timeline_response");
      const sticky = page.getByTestId("sticky-user-message");
      if (indexed) {
        await expect(sticky.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
        gate.releaseHeldServerMessage("agent.timeline.list_prompts.response");
      }
      await expect(sticky.getByRole("alert")).toHaveText("Could not load user messages.");
      gate.allowPromptIndexResponses();
      gate.allowTimelineResponses();
      await sticky.getByRole("button", { name: "Retry", exact: true }).click();
      await expect(sticky).toHaveCount(0);
      const recovered = actualUserRow(page, prompt);
      await expect(recovered).toHaveCount(1);
      await expect(recovered).toHaveAttribute("data-prompt-pinned", "true");
      await expectNearBottom(page);
      // The pinned prompt itself is the reveal link, including when its outline index failed.
      await recovered.getByRole("link", { name: prompt, exact: true }).click();
      await expectTimelinePromptLandedBelowTop(page, prompt);
      await page.screenshot({
        path: `../../docs/qa-evidence/sticky-user-message/discovery-${indexed ? "indexed" : "pagination"}.png`,
      });
    } finally {
      await agent.cleanup();
    }
  });
}

/** Preserve glyph placement across LCD and grayscale antialiasing used by opaque
 * and translucent browser layers. Only the one-pixel antialiased edge can differ.
 */
/** Capture only currently painted text pixels without element screenshot auto-scrolling. */
/** Compare painted bubble pixels at fine forward/reverse offsets around the pin threshold. */
async function expectSinglePaintedPromptHandoff({
  page,
  prompt,
  width,
  disclosure,
}: {
  page: Page;
  prompt: string;
  width: number;
  disclosure: "none" | "more";
}) {
  const timeline = page.getByTestId("agent-chat-scroll");
  const row = actualUserRow(page, prompt);
  await expect(row).toHaveCount(1);
  if ((await row.getAttribute("data-prompt-pinned")) === "true") {
    await row.getByTestId("user-message-content-target").click({ position: { x: 10, y: 4 } });
    await expectTimelinePromptLandedBelowTop(page, prompt);
  }
  await expect(row).toHaveAttribute("data-prompt-pinned", "false");
  await expect(row.getByTestId("user-message-prefix-mask")).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  await timeline.hover();
  const viewport = (await timeline.boundingBox())!;
  const originalWrapper = (await row.boundingBox())!;
  await expect.poll(() => row.evaluate(actualRowTailHandoffDistance)).not.toBeNull();
  const handoffDistance = await row.evaluate(actualRowTailHandoffDistance);
  if (handoffDistance === null)
    throw new Error("The actual prompt has no qualified tail handoff geometry");
  const tailOffset = handoffDistance - (originalWrapper.y - viewport.y);
  const body = row.getByTestId("user-message-bubble");
  const sourceBox = (await body.boundingBox())!;
  const originalText = row.getByTestId("user-message-text");
  const textHandle = await originalText.elementHandle();
  const originalTextBox = (await originalText.boundingBox())!;
  const originalPixels = await captureVisibleActualPrompt(page, originalText, true);
  for (const offset of [6, 3, 1, -1, -3, -6, -12, -24, -12, -3, -1, 1, 3, 6]) {
    const current = (await row.boundingBox())!;
    await page.mouse.wheel(0, current.y - viewport.y + tailOffset - offset);
    await expect
      .poll(async () => (await row.boundingBox())!.y - viewport.y)
      .toBeCloseTo(offset - tailOffset, 0);
    await expect(row).toHaveAttribute("data-prompt-pinned", offset > 0 ? "false" : "true");
    await expectActualTextIdentity(row, textHandle!, prompt);
    const bounds = (await body.boundingBox())!;
    expect(bounds.x).toBeCloseTo(sourceBox.x, 0);
    expect(bounds.width).toBeCloseTo(sourceBox.width, 0);
    if (offset > 0) {
      expect(bounds.height).toBeCloseTo(sourceBox.height, 0);
      continue;
    }
    await expectActualSingleLineGeometry(row);
    // Pin the shortened paint edge; original inline allocation remains unchanged.
    expect(bounds.y).toBeCloseTo(viewport.y + sourceBox.y - originalWrapper.y, 0);
    const textBounds = (await originalText.boundingBox())!;
    expect(textBounds.x).toBeCloseTo(originalTextBox.x, 3);
    expect(textBounds.y - bounds.y).toBeCloseTo(originalTextBox.y - sourceBox.y, 3);
    expect(textBounds.width).toBeCloseTo(originalTextBox.width, 3);
    expect(textBounds.height).toBeCloseTo(originalTextBox.height, 3);
    await expect(row.getByTestId("user-message-disclosure")).toHaveCount(
      disclosure === "more" ? 1 : 0,
    );
    await expectMatchingPromptInk(page, originalPixels, originalText, {
      firstLineOnly: true,
      allowCompactOverlay: disclosure === "more",
    });
    await page.screenshot({
      path: `../../docs/qa-evidence/sticky-user-message/single-copy-${width}-${offset}.png`,
    });
  }
}

test("keeps colored pinned disclosure readable before and during hover", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    localStorage.setItem(
      "@paseo:app-settings",
      JSON.stringify({ theme: "dark", accentColor: "blue" }),
    );
  });
  const prompt = `Review this code:\n${"const value = 42;\n".repeat(12)}https://example.test`;
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "accent-pinned-hover",
    title: "Accent pinned prompt",
    initialPrompt: prompt,
  });
  try {
    await agent.client.waitForFinish(agent.agentId, 15_000);
    await agent.client.sendAgentMessage(
      agent.agentId,
      "emit 85 assistant messages before synthetic user message",
    );
    await agent.client.waitForFinish(agent.agentId, 15_000);
    await page.setViewportSize(WIDE_VIEWPORT);
    await openAgentRoute(page, agent);
    await chatOutlineRail(page).getByRole("tab").first().click();
    await expectTimelinePromptLandedBelowTop(page, prompt);
    await scrollActualRowPastTailHandoff(page, actualUserRow(page, prompt));
    const sticky = actualUserRow(page, prompt);
    const bubble = sticky.getByTestId("user-message-bubble");
    const disclosure = sticky.getByTestId("user-message-disclosure");
    const label = disclosure.getByText("more…", { exact: true });
    await expect(bubble).toHaveCSS("background-color", "rgb(155, 175, 197)");
    await expect(sticky.getByTestId("user-message-text")).toHaveCSS("color", "rgb(24, 24, 27)");
    await page.mouse.move(2, 2);
    await expect(label).toHaveCSS("color", "rgb(24, 24, 27)");
    await expect(disclosure).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await disclosure.hover();
    await expect(label).toHaveCSS("color", "rgb(24, 24, 27)");
    await expect(disclosure).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await page.screenshot({
      path: testInfo.outputPath("accent-pinned-more-hover.png"),
      fullPage: true,
    });
    await disclosure.click();
    await expect(disclosure).toHaveText("less…");
    await expect(disclosure.getByText("less…", { exact: true })).toHaveCSS(
      "color",
      "rgb(24, 24, 27)",
    );
  } finally {
    await agent.cleanup();
  }
});

test("reaches bottom through a very large last USER without a measurement update loop", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const prompt = Array.from(
    { length: 1500 },
    (_, index) =>
      `Crash reproduction paragraph ${index}: ${"Keep this actual user message at its original inline size. ".repeat(3)}`,
  )
    .join("\n")
    .trim();
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "large-last-user-handoff-",
    title: "Large last USER handoff",
    featureValues: { mockAssistantResponse: STICKY_RESPONSE },
  });
  try {
    await agent.client.sendAgentMessage(agent.agentId, "An earlier user prompt.");
    await agent.client.waitForFinish(agent.agentId, 15_000);
    await agent.client.sendAgentMessage(agent.agentId, prompt);
    await agent.client.waitForFinish(agent.agentId, 15_000);
    await page.setViewportSize(WIDE_VIEWPORT);
    await openAgentTimeline(page, agent);
    const timeline = page.getByTestId("agent-chat-scroll");
    const row = actualUserRow(page, "Crash reproduction paragraph 1499:");
    await expect(row).toHaveCount(1);
    await waitForTimelineGeometryToSettle(page);
    const text = await row.getByTestId("user-message-text").elementHandle();
    expect(text).not.toBeNull();
    for (const delta of [-400, 10_000_000, -1200, 10_000_000]) {
      await timeline.hover();
      await page.mouse.wheel(0, delta);
      await waitForTimelineGeometryToSettle(page);
      await expect(page.getByText("Paseo ran into a problem.", { exact: true })).toHaveCount(0);
      await expect(row).toHaveCount(1);
    }
    await expectNearBottom(page);
    await expect(row).toHaveAttribute("data-prompt-pinned", "true");
    const disclosure = row.getByTestId("user-message-disclosure");
    await disclosure.click();
    await expect(disclosure).toHaveAttribute("aria-expanded", "true");
    await disclosure.click();
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await expectNearBottom(page);
    await expectActualTextIdentity(row, text!, prompt);
  } finally {
    await agent.cleanup();
  }
});

/** One finished, cold real-renderer cohort; no scroll or source publication is synthesized. */
function observeColdHoverTranscript(
  element: HTMLElement | SVGElement,
  ids: { prompt: string; answer: string },
) {
  if (!(element instanceof HTMLElement)) throw new Error("The timeline is not an HTMLElement");
  const timeline = element;
  const prompt = timeline.querySelector<HTMLElement>(`[data-retained-prompt-row="${ids.prompt}"]`)!;
  const actualBody = prompt.querySelector<HTMLElement>('[data-testid="user-message"]')!;
  const text = prompt.querySelector<HTMLElement>('[data-testid="user-message-text"]')!;
  const textNode = document.createTreeWalker(text, NodeFilter.SHOW_TEXT).nextNode();
  const answer = timeline.querySelector<HTMLElement>(`[data-history-row-id="${ids.answer}"]`)!;
  const assistant = answer.querySelector<HTMLElement>('[data-testid="assistant-message"]')!;
  const assistantText = document.createTreeWalker(assistant, NodeFilter.SHOW_TEXT).nextNode();
  if (!textNode || !assistantText)
    throw new Error("The real USER and Markdown require actual Text nodes");
  function snapshot() {
    const viewport = timeline.getBoundingClientRect();
    const ordinary = Array.from(timeline.querySelectorAll<HTMLElement>("[data-history-row-id]"));
    const content = prompt.querySelector<HTMLElement>("[data-actual-prompt-content]")!;
    const inner = prompt.querySelector<HTMLElement>('[data-testid="user-message-body-scroll"]')!;
    return {
      source: {
        ordinaryIds: ordinary.map((row) => row.dataset.historyRowId),
        assistant: assistant.textContent,
        prompt: text.textContent,
      },
      geometry: {
        scrollTop: timeline.scrollTop,
        scrollHeight: timeline.scrollHeight,
        scrollWidth: timeline.scrollWidth,
        clientHeight: timeline.clientHeight,
        clientWidth: timeline.clientWidth,
        rows: ordinary.map((row) => {
          const bounds = row.getBoundingClientRect();
          const style = getComputedStyle(row);
          return {
            id: row.dataset.historyRowId,
            x: bounds.left - viewport.left,
            top: bounds.top - viewport.top,
            width: bounds.width,
            allocation:
              bounds.height +
              Number.parseFloat(style.marginTop) +
              Number.parseFloat(style.marginBottom),
          };
        }),
        flowHeight: Number(content.dataset.promptFlowHeight),
        compactHeight: Number(content.dataset.promptCompactHeight),
        visualHeight: Number(content.dataset.promptVisualHeight),
        bounded: content.dataset.promptBounded,
        bodyExpanded: inner.dataset.bodyExpanded,
        body: content.getBoundingClientRect().toJSON(),
        text: text.getBoundingClientRect().toJSON(),
      },
      identity: {
        body: prompt.querySelector('[data-testid="user-message"]') === actualBody,
        text: prompt.querySelector('[data-testid="user-message-text"]') === text,
        textNode: text.contains(textNode!),
        assistant: answer.querySelector('[data-testid="assistant-message"]') === assistant,
        assistantText: assistant.contains(assistantText!),
        actualOwners: timeline.querySelectorAll(
          `[data-retained-prompt-row="${ids.prompt}"], [data-history-row-id="${ids.prompt}"]`,
        ).length,
      },
    };
  }
  const original = timeline.scrollTo;
  const ownDescriptor = Object.getOwnPropertyDescriptor(timeline, "scrollTo");
  const calls: Array<{
    args: [options?: ScrollToOptions] | [x: number, y: number];
    stack: string | undefined;
  }> = [];
  let started = false;
  let baseline: ReturnType<typeof snapshot> | null = null;
  function callThroughScrollTo(...args: [options?: ScrollToOptions] | [x: number, y: number]) {
    if (started)
      calls.push({ args, stack: new Error("Real outer scrollTo after pointer entry").stack });
    Reflect.apply(original, timeline, args);
  }
  timeline.scrollTo = callThroughScrollTo;
  function begin() {
    // Exactly one input boundary, before the first real hover handler. Startup
    // verification is excluded; there is no later reset, retry, or sample drop.
    baseline = snapshot();
    started = true;
  }
  timeline.addEventListener("pointerover", begin, { capture: true, once: true });
  return {
    read: snapshot,
    baseline: () => baseline,
    calls: () => calls,
    async sampleFrames(count: number) {
      const samples: ReturnType<typeof snapshot>[] = [];
      for (let frame = 0; frame < count; frame += 1) {
        await new Promise<number>((resolve) => requestAnimationFrame(resolve));
        samples.push(snapshot());
      }
      return samples;
    },
    restore() {
      timeline.removeEventListener("pointerover", begin, true);
      if (ownDescriptor) Object.defineProperty(timeline, "scrollTo", ownDescriptor);
      else Reflect.deleteProperty(timeline, "scrollTo");
    },
  };
}

function realHoverPoint(node: HTMLElement | SVGElement) {
  const scroll = node.closest('[data-testid="agent-chat-scroll"]')!;
  const viewport = scroll.getBoundingClientRect();
  const bounds = node.getBoundingClientRect();
  const left = Math.max(viewport.left + 1, bounds.left + 1);
  const right = Math.min(viewport.right - 1, bounds.right - 1);
  const top = Math.max(viewport.top + 1, bounds.top + 1);
  const bottom = Math.min(viewport.bottom - 1, bounds.bottom - 1);
  if (right <= left || bottom <= top)
    throw new Error("Real hover target has no visible viewport intersection");
  const x = (left + right) / 2;
  const y = (top + bottom) / 2;
  if (!node.contains(document.elementFromPoint(x, y)))
    throw new Error("The real hover point is owned by another surface");
  return { x, y };
}

function isColdHoverTail(entry: TimelineWindowPageReceipt): boolean {
  return entry.direction === "tail" && entry.entries.length === 40;
}

function assertColdHoverSamples(
  baseline: NonNullable<ReturnType<ReturnType<typeof observeColdHoverTranscript>["baseline"]>>,
  samples: Array<ReturnType<ReturnType<typeof observeColdHoverTranscript>["read"]>>,
  phase: string,
) {
  for (const [frame, sample] of samples.entries()) {
    const evidence = JSON.stringify({ phase, frame, baseline, sample });
    expect(
      sample.source,
      `Finished source changed; hover causality is not established. ${evidence}`,
    ).toEqual(baseline.source);
    expect(sample.identity, evidence).toEqual({
      body: true,
      text: true,
      textNode: true,
      assistant: true,
      assistantText: true,
      actualOwners: 1,
    });
    expect(sample.geometry, evidence).toEqual(baseline.geometry);
  }
}

test("keeps the finished cold real transcript stationary after hover input stops", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    localStorage.setItem(
      "@paseo:app-settings",
      JSON.stringify({ theme: "dark", accentColor: "blue", toolCallDetailLevel: "overview" }),
    );
  });
  const agent = await seedRemoteToolRunTimeline();
  let observedHistory: Awaited<ReturnType<typeof holdAgentOlderTimelinePages>> | undefined;
  const evidence: Record<string, unknown> = {};
  let observation: JSHandle<ReturnType<typeof observeColdHoverTranscript>> | undefined;
  try {
    const history = await holdAgentOlderTimelinePages(page, agent.agentId, undefined, {
      contextDelivery: "immediate",
    });
    observedHistory = history;
    const finished = await agent.client.waitForFinish(agent.agentId, 15_000);
    expect(finished.status).not.toBe("running");
    expect(finished.final?.lastError ?? null).toBeNull();
    const beforeAgents = await agent.client.fetchAgents();
    const beforeAgent = beforeAgents.entries.find(
      (entry) => entry.agent.id === agent.agentId,
    )!.agent;
    expect(beforeAgent.status).not.toBe("running");
    await page.setViewportSize(WIDE_VIEWPORT);
    // This freshly seeded agent has never been opened by this browser. Real
    // bootstrap and source probes own acquisition, without readAt/wheel/jumps.
    await openAgentTimeline(page, agent);
    const timeline = page.getByTestId("agent-chat-scroll").filter({ visible: true });
    await expect.poll(() => history.getWindowPages().some(isColdHoverTail)).toBe(true);
    const tail = history.getWindowPages().find(isColdHoverTail)!;
    expect(tail.forwarded).toBe(true);
    expect(tail.hasOlder).toBe(true);
    expect(tail.entries.filter((entry) => entry.type === "user_message")).toHaveLength(0);
    expect(tail.entries.filter((entry) => entry.type === "tool_call").length).toBeGreaterThan(0);
    expect(tail.entries.at(-1)!.type).toBe("assistant_message");
    const answerId = tail.entries.at(-1)!.messageId!;
    expect(answerId).toEqual(expect.any(String));
    await expect(timeline.getByTestId("tool-call-group")).toHaveCount(1);
    const answer = timeline.locator(`[data-history-row-id="${answerId}"]`);
    const assistant = answer.getByTestId("assistant-message");
    await expect(assistant.getByText(agent.readerText, { exact: true })).toHaveCount(1);
    await expect.poll(() => history.getMountingPrompt()?.text).toBe(agent.prompt);
    const recovered = history.getMountingPrompt()!;
    expect(tail.entries.map((entry) => entry.messageId)).not.toContain(recovered.id);
    const row = timeline.locator(`[data-retained-prompt-row="${recovered.id}"]`);
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId("user-message-text")).toHaveText(agent.prompt);
    await expect(row.getByTestId("user-message-text")).toBeVisible();
    await expect(row).toHaveAttribute("data-prompt-pinned", "true");
    await expect.poll(() => history.getReadAccounting().pendingContext ?? 0).toBe(0);
    await expect.poll(() => history.getReadAccounting().pendingContent).toBe(0);
    expect(history.getReadAccounting().contextBefore ?? 0).toBeGreaterThan(0);
    expect(history.getReadAccounting().contentBefore).toBeGreaterThan(0);
    expect(history.getReadAccounting().errors).toEqual([]);
    expect(history.getRequestCount()).toBe(0);
    await page.evaluate(() => document.fonts.ready);
    // Leave the timeline before installing the one-entry callthrough boundary.
    const outside = await timeline.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      if (bounds.left < 2) throw new Error("The wide full-app timeline has no left outside point");
      return { x: bounds.left - 1, y: bounds.top + 4 };
    });
    await page.mouse.move(outside.x, outside.y);
    await waitForTimelineGeometryToSettle(page);
    const state = await timeline.evaluateHandle(observeColdHoverTranscript, {
      prompt: recovered.id,
      answer: answerId,
    });
    observation = state;
    const startup = await state.evaluate((value) => value.read());
    expect(startup.geometry.flowHeight).toBeGreaterThan(0);
    expect(startup.geometry.compactHeight).toBeGreaterThan(0);
    expect(startup.geometry.bounded).toBe("true");
    evidence.startup = startup;
    const bubble = row.getByTestId("user-message-bubble");
    const actions = row.getByTestId("user-message-trailing-row");
    for (const target of [bubble, actions, assistant, bubble, actions, assistant]) {
      const point = await target.evaluate(realHoverPoint);
      await page.mouse.move(point.x, point.y, { steps: 4 });
      if (target === bubble) await expect(actions).toHaveCSS("opacity", "1");
    }
    const baseline = await state.evaluate((value) => value.baseline());
    expect(baseline).not.toBeNull();
    evidence.baseline = baseline;
    assertColdHoverSamples(startup, [baseline!], "first-real-pointer-entry-before-handler");
    const stationary = await state.evaluate((value) => value.sampleFrames(24));
    evidence.stationary = stationary;
    assertColdHoverSamples(baseline!, stationary, "pointer-stopped-over-real-Markdown");
    await page.mouse.move(outside.x, outside.y, { steps: 4 });
    const pointerOut = await state.evaluate((value) => value.sampleFrames(24));
    evidence.pointerOut = pointerOut;
    assertColdHoverSamples(baseline!, pointerOut, "pointer-stopped-outside-transcript");
    const afterAgents = await agent.client.fetchAgents();
    const afterAgent = afterAgents.entries.find((entry) => entry.agent.id === agent.agentId)!.agent;
    expect(afterAgent.status, "The seed started running during the hover observation").toBe(
      beforeAgent.status,
    );
    const calls = await state.evaluate((value) => value.calls());
    evidence.outerCalls = calls;
    expect(calls).toEqual([]);
    expect(history.getRequestCount()).toBe(0);
    expect(history.getReadAccounting().errors).toEqual([]);
    expect(history.getWindowPages()).toEqual([tail]);
  } finally {
    try {
      if (observation) {
        evidence.final = await observation
          .evaluate((value) => ({ snapshot: value.read(), calls: value.calls() }))
          .catch((error: unknown) => ({ captureError: String(error) }));
        // Disposal is test-only cleanup; the real scroll implementation was
        // called throughout observation, and its exact original descriptor returns.
        await observation.evaluate((value) => value.restore());
        await observation.dispose();
      }
      await testInfo.attach("finished-cold-hover-stationary", {
        body: JSON.stringify(
          {
            ...evidence,
            accounting: observedHistory?.getReadAccounting(),
            pages: observedHistory?.getWindowPages(),
          },
          null,
          2,
        ),
        contentType: "application/json",
      });
    } finally {
      await agent.cleanup();
    }
  }
});
