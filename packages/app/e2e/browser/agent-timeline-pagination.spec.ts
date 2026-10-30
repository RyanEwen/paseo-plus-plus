import { expect, test } from "../support/fixtures";
import {
  holdAgentOlderTimelinePages,
  type TimelineWindowPageReceipt,
} from "../support/helpers/agent-timeline-gate";
import {
  withSpokenTimeline,
  captureSpokenTimeline,
  reloadSpokenTimeline,
  expectSpokenTimelinePrompt,
  sendSpokenTimelinePrompt,
  expectStableHistoryStartGutter,
  expectTimelineAtHistoryStart,
  expectTimelinePromptCentered,
  expectTimelinePromptNotMounted,
  expectTimelinePromptPositionPreserved,
  expectTimelinePromptLandedBelowTop,
  expectTimelinePromptVisible,
  holdBootstrapTimelinePage,
  holdDaemonHydration,
  holdOlderHistoryPages,
  makeLoadedTimelineFitViewport,
  openAgentTimeline,
  rememberTimelineViewport,
  rememberTimelinePromptPosition,
  reloadAgentTimelineFromPersistedReplica,
  scrollTimelineUntilOlderHistoryIsReachable,
  scrollTimelineToOldestLoadedEdge,
  scrollTimelineToNewestLoadedEdge,
  seedLongMockAgentTimeline,
  scrollThroughOlderHistoryPages,
  seedRealisticOlderTimeline,
  seedRemoteToolRunTimeline,
  waitForTimelineGeometryToSettle,
  sendLiveTurnBeforeHydration,
  expectTimelineViewportAnchoredAfterPrepend,
  userNavigatesTimelineToHistoryStartWithKeyboard,
  userScrollsTimelineToHistoryStart,
} from "../support/helpers/timeline-pagination";

function isRemoteToolRunTail(entry: TimelineWindowPageReceipt): boolean {
  return entry.direction === "tail" && entry.entries.length === 40;
}

function isOlderWindowPage(entry: TimelineWindowPageReceipt): boolean {
  return entry.direction === "before";
}

function readToolGroupHistoryRowId(element: HTMLElement | SVGElement) {
  return element.closest<HTMLElement>("[data-history-row-id]")!.dataset.historyRowId;
}

/** Test-local physical evidence, sampled without moving the actual scroll owner. */
function readRemoteToolRunViewport(element: HTMLElement | SVGElement) {
  const bounds = element.getBoundingClientRect();
  return {
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
    width: bounds.width,
    height: bounds.height,
    rows: Array.from(element.querySelectorAll<HTMLElement>("[data-history-row-id]"), (row) => {
      const rect = row.getBoundingClientRect();
      const body = row.querySelector<HTMLElement>("[data-actual-prompt-content]");
      return {
        id: row.dataset.historyRowId,
        top: rect.top - bounds.top,
        height: rect.height,
        promptFlowHeight: body ? Number(body.dataset.promptFlowHeight) : null,
      };
    }),
  };
}

/** Canonical identity is independent of ordinary versus retained-only paint membership. */
function readActualPromptRowId(element: HTMLElement | SVGElement): string {
  const id =
    element.getAttribute("data-history-row-id") ?? element.getAttribute("data-retained-prompt-row");
  if (!id) throw new Error("Actual prompt has no canonical row identity");
  return id;
}

function isColdInitialTail(entry: TimelineWindowPageReceipt): boolean {
  return (
    isRemoteToolRunTail(entry) &&
    entry.entries.at(-3)?.type === "assistant_message" &&
    entry.entries.at(-2)?.type === "user_message" &&
    entry.entries.at(-1)?.type === "assistant_message"
  );
}

function readColdInitialEdge(
  element: HTMLElement | SVGElement,
  ids: { answerId: string; newerId: string },
) {
  const bounds = element.getBoundingClientRect();
  const rows = Array.from(element.querySelectorAll<HTMLElement>("[data-history-row-id]"));
  // The isolated USER is display context, not an ordinary window reading anchor.
  const ordinary = rows.filter(
    (row) =>
      !row.hasAttribute("data-actual-prompt-row") || row.dataset.historyRowId === ids.newerId,
  );
  const first = ordinary.find((row) => row.getBoundingClientRect().bottom > bounds.top + 8);
  const answer = rows.find((row) => row.dataset.historyRowId === ids.answerId);
  const newer = rows.find((row) => row.dataset.historyRowId === ids.newerId);
  return {
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
    edgeId: first?.dataset.historyRowId,
    answer: answer
      ? {
          id: answer.dataset.historyRowId,
          top: answer.getBoundingClientRect().top - bounds.top,
          bottom: answer.getBoundingClientRect().bottom - bounds.top,
          height: answer.getBoundingClientRect().height,
          text: answer.textContent,
          marker: answer.dataset.coldInitialReader,
        }
      : null,
    newer: newer
      ? {
          id: newer.dataset.historyRowId,
          top: newer.getBoundingClientRect().top - bounds.top,
          marker: newer.dataset.coldInitialNewer,
        }
      : null,
  };
}

/** Observe only the committed ordinary cohort, independently of retained-only paint.
 * The outer margin box is layout allocation; its child can have different sticky paint.
 */
function readOrdinaryTranscriptGeometry(
  element: HTMLElement | SVGElement,
  cohortIds: readonly string[] | null,
) {
  const viewport = element.getBoundingClientRect();
  const ordinary = Array.from(
    element.querySelectorAll<HTMLElement>("[data-history-row-id]"),
  ).filter((row) => cohortIds === null || cohortIds.includes(row.dataset.historyRowId!));
  const rows = ordinary.map((row) => {
    const id = row.dataset.historyRowId;
    if (!id) throw new Error("An ordinary cohort row has no canonical identity");
    const bounds = row.getBoundingClientRect();
    const style = getComputedStyle(row);
    const marginTop = Number.parseFloat(style.marginTop);
    const marginBottom = Number.parseFloat(style.marginBottom);
    const allocation = bounds.height + marginTop + marginBottom;
    if (!Number.isFinite(allocation) || allocation <= 0)
      throw new Error("An ordinary cohort row has no positive outer allocation");
    return {
      id,
      text: row.textContent,
      x: bounds.left - viewport.left,
      top: bounds.top - viewport.top - marginTop,
      width: bounds.width,
      allocation,
    };
  });
  return {
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    scrollWidth: element.scrollWidth,
    clientHeight: element.clientHeight,
    clientWidth: element.clientWidth,
    rows,
  };
}

/** The original must arrive in a real accepted window, not another isolated content response. */
function hasMaterializedPromptPage(
  pages: readonly TimelineWindowPageReceipt[],
  id: string,
): boolean {
  return pages.some(
    (page) =>
      page.direction === "before" &&
      page.forwarded &&
      page.entries.some((entry) => entry.type === "user_message" && entry.messageId === id),
  );
}

test.describe("Agent timeline pagination", () => {
  test("shows spoken words without voice instructions in history, live updates and after reload", async ({
    page,
  }, testInfo) => {
    const historyText = "Please check the voice history.";
    const liveText = "Now check the live voice message.";
    await withSpokenTimeline(historyText, async (agent) => {
      await openAgentTimeline(page, agent);
      await expectSpokenTimelinePrompt(page, historyText);
      await sendSpokenTimelinePrompt(agent, liveText);
      await expectSpokenTimelinePrompt(page, liveText);
      await captureSpokenTimeline(page, testInfo, "desktop");
      await reloadSpokenTimeline(page);
      await expectSpokenTimelinePrompt(page, liveText);
      await captureSpokenTimeline(page, testInfo, "compact");
      await expectSpokenTimelinePrompt(page, liveText);
    });
  });

  test("keeps the history-start gutter and visible position stable through the final page", async ({
    page,
  }) => {
    const agent = await seedLongMockAgentTimeline({ turns: 40 });
    try {
      const history = await holdOlderHistoryPages(page, agent);
      await openAgentTimeline(page, agent);
      await expectStableHistoryStartGutter(page);

      await userScrollsTimelineToHistoryStart(page);
      await history.expectRequestedPages(1);
      await expectStableHistoryStartGutter(page);
      const viewport = await rememberTimelineViewport(page);

      history.releasePage(1);
      await expectTimelineViewportAnchoredAfterPrepend(page, viewport);
      await history.expectSettledWithRequestedPages(1);
      await expectStableHistoryStartGutter(page);
    } finally {
      await agent.cleanup();
    }
  });

  test("loads one page each time the user returns to history start", async ({ page }) => {
    test.setTimeout(120_000);
    const agent = await seedLongMockAgentTimeline({ turns: 80 });
    try {
      const history = await holdOlderHistoryPages(page, agent);
      await openAgentTimeline(page, agent);
      await expectTimelinePromptVisible(page, agent.newestPrompt);
      await expectTimelinePromptCentered(page, agent.newestPrompt);
      await expectTimelinePromptNotMounted(page, agent.oldestPrompt);
      await expectTimelinePromptNotMounted(page, agent.initialTailOldestPrompt);

      await userScrollsTimelineToHistoryStart(page);
      await expectTimelinePromptVisible(page, agent.initialTailOldestPrompt);
      await history.expectRequestedPages(1);
      const viewport = await rememberTimelineViewport(page);
      history.releasePage(1);
      await expectTimelineViewportAnchoredAfterPrepend(page, viewport);
      await history.expectSettledWithRequestedPages(1);

      await userScrollsTimelineToHistoryStart(page);
      await expectTimelinePromptCentered(page, agent.firstOlderPagePrompt);
      await history.expectRequestedPages(2);
    } finally {
      await agent.cleanup();
    }
  });

  test("loads older history when the user navigates to history start with the keyboard", async ({
    page,
  }) => {
    const agent = await seedLongMockAgentTimeline({ turns: 40 });
    try {
      const history = await holdOlderHistoryPages(page, agent);
      await openAgentTimeline(page, agent);

      await userNavigatesTimelineToHistoryStartWithKeyboard(page);
      await history.expectRequestedPages(1);
    } finally {
      await agent.cleanup();
    }
  });

  test("does not repeat an assistant block that spans older history pages", async ({ page }) => {
    test.setTimeout(120_000);
    const agent = await seedRealisticOlderTimeline();
    try {
      const history = await holdOlderHistoryPages(page, agent);
      await openAgentTimeline(page, agent);
      await expectTimelinePromptVisible(page, agent.newestPrompt);

      await scrollThroughOlderHistoryPages(page, 3, history);
      history.expectNoRepeatedEntries();
    } finally {
      await agent.cleanup();
    }
  });

  for (const cohort of [
    { name: "normal", prefixTurns: 3, virtualized: false },
    { name: "virtual-host", prefixTurns: 12, virtualized: true },
  ] as const) {
    test(`keeps one actual recovered USER body through original materialization (${cohort.name})`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.addInitScript((virtualized) => {
        localStorage.setItem(
          "@paseo:app-settings",
          JSON.stringify({ theme: "dark", accentColor: "blue", toolCallDetailLevel: "overview" }),
        );
        if (virtualized) {
          // The existing image-continuity fixture uses these same supported
          // virtualization cohort inputs; all dimensions and rows remain real.
          Reflect.set(globalThis, "__PASEO_E2E_WEB_PARTIAL_VIRTUALIZATION_THRESHOLD", 10);
          Reflect.set(globalThis, "__PASEO_E2E_WEB_MOUNTED_RECENT_STREAM_ITEMS", 5);
        }
      }, cohort.virtualized);
      const agent = await seedRemoteToolRunTimeline({ prefixTurns: cohort.prefixTurns });
      const observations: Record<string, unknown> = {};
      let gate: Awaited<ReturnType<typeof holdAgentOlderTimelinePages>> | undefined;
      try {
        gate = await holdAgentOlderTimelinePages(page, agent.agentId, undefined, {
          contextDelivery: "immediate",
        });
        await openAgentTimeline(page, agent);
        const timeline = page.getByTestId("agent-chat-scroll").filter({ visible: true });
        await expect.poll(() => gate!.getWindowPages().some(isRemoteToolRunTail)).toBe(true);
        const tail = gate.getWindowPages().find(isRemoteToolRunTail)!;
        expect(tail.entries.filter((entry) => entry.type === "user_message")).toHaveLength(0);
        await expect.poll(() => gate!.getMountingPrompt()?.text).toBe(agent.prompt);
        const recovered = gate.getMountingPrompt()!;
        expect(tail.entries.map((entry) => entry.messageId)).not.toContain(recovered.id);
        const body = page.getByTestId("user-message").filter({ hasText: agent.prompt });
        const text = page.getByTestId("user-message-text").filter({ hasText: agent.prompt });
        await expect(body).toHaveCount(1);
        await expect(text).toHaveCount(1);
        await expect(text).toHaveText(agent.prompt);
        await expect(body).toBeInViewport();
        await waitForTimelineGeometryToSettle(page);
        expect(gate.getRequestCount()).toBe(0);
        expect(gate.getReadAccounting().errors).toEqual([]);
        const naturalFlow = await body.evaluate((element) =>
          Number(
            element.closest<HTMLElement>("[data-actual-prompt-content]")!.dataset.promptFlowHeight,
          ),
        );
        expect(naturalFlow).toBeGreaterThan(0);
        observations.before = await timeline.evaluate(readOrdinaryTranscriptGeometry, null);
        const original = await body.evaluateHandle((element) => {
          const textElement = element.querySelector('[data-testid="user-message-text"]')!;
          return {
            body: element,
            text: textElement,
            leaf: document.createTreeWalker(textElement, NodeFilter.SHOW_TEXT).nextNode(),
          };
        });
        try {
          // This is the real existing reveal action and accepted viewed-window
          // request. Releasing its response neither injects a row nor publishes a reading edge.
          gate.releasePage(1);
          await body
            .getByTestId("user-message-content-target")
            .click({ position: { x: 10, y: 4 } });
          await expect
            .poll(() => hasMaterializedPromptPage(gate!.getWindowPages(), recovered.id))
            .toBe(true);
          await expectTimelinePromptLandedBelowTop(page, agent.prompt);
          const ordinary = timeline.locator(`[data-history-row-id="${recovered.id}"]`);
          await expect(ordinary).toHaveCount(1);
          await expect(ordinary).toHaveAttribute("data-prompt-pinned", "false");
          await expect(body).toHaveCount(1);
          await expect(text).toHaveCount(1);
          await expect(ordinary.getByTestId("user-message-text")).toHaveText(agent.prompt);
          await expect(page.locator("[data-retained-prompt-row]")).toHaveCount(0);
          expect(
            await body.evaluate(
              (element, prior) =>
                element === prior.body &&
                element.querySelector('[data-testid="user-message-text"]') === prior.text &&
                prior.leaf !== null &&
                prior.text.contains(prior.leaf),
              original,
            ),
          ).toBe(true);
          await waitForTimelineGeometryToSettle(page);
          const ordinaryFlow = await body.evaluate((element) =>
            Number(
              element.closest<HTMLElement>("[data-actual-prompt-content]")!.dataset
                .promptFlowHeight,
            ),
          );
          expect(ordinaryFlow).toBe(naturalFlow);
          const layout = await timeline.evaluate(readOrdinaryTranscriptGeometry, [recovered.id]);
          expect(layout.rows).toHaveLength(1);
          expect(layout.rows[0]!.allocation).toBeGreaterThanOrEqual(ordinaryFlow);
          expect(gate.getOwnedEntryCountContaining(agent.prompt)).toBe(1);
          expect(gate.getRequestCount()).toBe(1);
          expect(gate.getReadAccounting().errors).toEqual([]);
          await expect(timeline).toHaveAttribute(
            "id",
            cohort.virtualized ? /web-dom-virtualized$/ : /web-dom-scroll$/,
          );
          await expect(page.getByTestId("load-older-history-spinner")).toBeHidden();
          observations.after = layout;
        } finally {
          await original.dispose();
        }
      } finally {
        try {
          await testInfo.attach(`single-body-materialization-${cohort.name}`, {
            body: Buffer.from(
              JSON.stringify(
                {
                  ...observations,
                  pages: gate?.getWindowPages(),
                  accounting: gate?.getReadAccounting(),
                },
                null,
                2,
              ),
            ),
            contentType: "application/json",
          });
        } finally {
          await agent.cleanup();
        }
      }
    });
  }

  test("keeps upstream ordinary transcript geometry when cold sticky context is recovered", async ({
    page,
  }, testInfo) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        "@paseo:app-settings",
        JSON.stringify({ theme: "dark", accentColor: "blue", toolCallDetailLevel: "overview" }),
      );
    });
    const agent = await seedRemoteToolRunTimeline();
    const observations: Record<string, unknown> = {};
    let gate: Awaited<ReturnType<typeof holdAgentOlderTimelinePages>> | undefined;
    try {
      // Hold only real canonical context responses. No scroll, reading publication,
      // main-window application or context injection is performed by this helper.
      gate = await holdAgentOlderTimelinePages(page, agent.agentId);
      await openAgentTimeline(page, agent);
      const timeline = page.getByTestId("agent-chat-scroll").filter({ visible: true });
      await expect.poll(() => gate!.getWindowPages().some(isRemoteToolRunTail)).toBe(true);
      const tail = gate.getWindowPages().find(isRemoteToolRunTail)!;
      expect(tail.forwarded).toBe(true);
      expect(tail.hasOlder).toBe(true);
      expect(tail.entries).toHaveLength(40);
      expect(tail.entries.filter((entry) => entry.type === "user_message")).toHaveLength(0);
      const answerId = tail.entries.at(-1)!.messageId!;
      expect(answerId).toEqual(expect.any(String));
      const answer = timeline.locator(`[data-history-row-id="${answerId}"]`);
      const paragraph = answer.getByText(agent.readerText, { exact: true });
      await expect(paragraph).toHaveCount(1);
      await expect(
        page.getByTestId("user-message-text").filter({ hasText: agent.prompt }),
      ).toHaveCount(0);
      await expect.poll(() => gate!.getReadAccounting().contextBefore ?? 0).toBeGreaterThan(0);
      await expect.poll(() => gate!.getReadAccounting().pendingContext ?? 0).toBe(0);
      await waitForTimelineGeometryToSettle(page);
      const before = await timeline.evaluate(readOrdinaryTranscriptGeometry, null);
      // This tail contains no USER and context is still held. These are the
      // ordinary canonical projection's actual mounted rows, not a guessed ID list.
      const ordinaryIds = before.rows.map((row) => row.id);
      expect(ordinaryIds).toContain(answerId);
      expect(new Set(ordinaryIds).size).toBe(ordinaryIds.length);
      observations.before = before;
      expect(before.scrollHeight).toBeGreaterThan(before.clientHeight);
      expect(gate.getRequestCount()).toBe(0);
      expect(gate.getReadAccounting().errors).toEqual([]);
      const text = await paragraph.evaluateHandle((element) =>
        document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode(),
      );
      try {
        gate.releaseContentReads();
        await expect.poll(() => gate!.getMountingPrompt()?.text).toBe(agent.prompt);
        const recovered = gate.getMountingPrompt()!;
        expect(tail.entries.map((entry) => entry.messageId)).not.toContain(recovered.id);
        const recoveredBody = page.getByTestId("user-message").filter({ hasText: agent.prompt });
        const recoveredText = page
          .getByTestId("user-message-text")
          .filter({ hasText: agent.prompt });
        await expect(recoveredBody).toHaveCount(1);
        await expect(recoveredText).toHaveCount(1);
        await expect(recoveredText).toHaveText(agent.prompt);
        await expect(recoveredText).toBeVisible();
        await waitForTimelineGeometryToSettle(page);
        const after = await timeline.evaluate(readOrdinaryTranscriptGeometry, ordinaryIds);
        observations.after = after;
        const evidence = JSON.stringify({
          before,
          after,
          tail,
          accounting: gate.getReadAccounting(),
        });
        // No retained-height compensation: sticky context must add zero transcript space.
        expect(after.scrollHeight, evidence).toBe(before.scrollHeight);
        expect(after.scrollWidth, evidence).toBe(before.scrollWidth);
        expect(after.clientHeight, evidence).toBe(before.clientHeight);
        expect(after.clientWidth, evidence).toBe(before.clientWidth);
        expect(
          after.rows.map((row) => row.id),
          evidence,
        ).toEqual(before.rows.map((row) => row.id));
        expect(
          after.rows.map((row) => row.text),
          evidence,
        ).toEqual(before.rows.map((row) => row.text));
        expect(Math.abs(after.scrollTop - before.scrollTop), evidence).toBeLessThanOrEqual(1);
        for (const [index, row] of before.rows.entries()) {
          const current = after.rows[index]!;
          expect(current.width, evidence).toBe(row.width);
          expect(current.allocation, evidence).toBe(row.allocation);
          expect(Math.abs(current.x - row.x), evidence).toBeLessThanOrEqual(1);
          expect(Math.abs(current.top - row.top), evidence).toBeLessThanOrEqual(1);
        }
        expect(
          await paragraph.evaluate(
            (element, prior) => prior !== null && element.contains(prior),
            text,
          ),
        ).toBe(true);
        await expect(recoveredBody).toHaveCount(1);
        await expect(recoveredText).toHaveCount(1);
        expect(gate.getReadAccounting().errors, evidence).toEqual([]);
        expect(gate.getReadAccounting().contentBefore, evidence).toBeGreaterThan(0);
        expect(gate.getRequestCount(), evidence).toBe(0);
        await expect(page.getByTestId("load-older-history-spinner")).toBeHidden();
      } finally {
        await text.dispose();
      }
    } finally {
      try {
        await testInfo.attach("sticky-context-ordinary-geometry", {
          body: Buffer.from(
            JSON.stringify(
              {
                ...observations,
                accounting: gate?.getReadAccounting(),
                pages: gate?.getWindowPages(),
              },
              null,
              2,
            ),
          ),
          contentType: "application/json",
        });
      } finally {
        await agent.cleanup();
      }
    }
  });

  test("acquires the cold initial reading-edge USER before input despite a newer USER below", async ({
    page,
  }, testInfo) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        "@paseo:app-settings",
        JSON.stringify({
          theme: "dark",
          accentColor: "blue",
          toolCallDetailLevel: "overview",
        }),
      );
    });
    const agent = await seedRemoteToolRunTimeline();
    const observations: Record<string, unknown> = {};
    let observedHistory: Awaited<ReturnType<typeof holdOlderHistoryPages>> | undefined;
    try {
      const newerPrompt = "cold-initial-newer-user: emit 1 coalesced agent stream updates";
      await agent.client.sendAgentMessage(agent.agentId, newerPrompt);
      await agent.client.waitForFinish(agent.agentId, 15_000);
      // This unique agent has never been browser-opened. Context responses pass
      // through the existing validators immediately; no input or helper publishes an edge.
      const history = await holdOlderHistoryPages(page, agent, undefined, {
        contextDelivery: "immediate",
      });
      observedHistory = history;
      await openAgentTimeline(page, agent);
      const timeline = page.getByTestId("agent-chat-scroll").filter({ visible: true });
      await expect.poll(() => history.windowPages().some(isColdInitialTail)).toBe(true);
      const tail = history.windowPages().find(isColdInitialTail)!;
      expect(tail.forwarded).toBe(true);
      expect(tail.hasOlder).toBe(true);
      expect(tail.entries).toHaveLength(40);
      const tailTools = tail.entries.filter((entry) => entry.type === "tool_call");
      expect(tailTools).toHaveLength(37);
      expect(tailTools[0]!.callId).toMatch(/:pagination-tool:84$/);
      expect(tailTools.at(-1)!.callId).toMatch(/:pagination-tool:120$/);
      const answerId = tail.entries.at(-3)!.messageId!;
      const newerId = tail.entries.at(-2)!.messageId!;
      expect(answerId).toEqual(expect.any(String));
      expect(newerId).toEqual(expect.any(String));
      expect(tail.entries.filter((entry) => entry.type === "user_message")).toHaveLength(1);
      const answer = timeline.locator(`[data-history-row-id="${answerId}"]`);
      const newer = timeline.locator(`[data-history-row-id="${newerId}"]`);
      await expect(answer).toHaveCount(1);
      await expect(newer.getByTestId("user-message-text")).toHaveText(newerPrompt);
      await waitForTimelineGeometryToSettle(page);
      const ids = { answerId, newerId };
      const before = await timeline.evaluate(readColdInitialEdge, ids);
      observations.before = before;
      observations.initialReceipts = JSON.stringify(history.windowPages());
      const admission = JSON.stringify({ tail, before });
      expect(before.edgeId, admission).toBe(answerId);
      expect(before.answer!.top, admission).toBeLessThanOrEqual(8);
      expect(before.answer!.bottom, admission).toBeGreaterThan(8);
      expect(before.newer!.top, admission).toBeGreaterThan(8);
      expect(before.scrollHeight, admission).toBeGreaterThan(before.clientHeight);
      expect(history.requestCount(), admission).toBe(0);
      await answer.evaluate((row) => row.setAttribute("data-cold-initial-reader", "original"));
      await newer.evaluate((row) => row.setAttribute("data-cold-initial-newer", "original"));
      const firstParagraph = answer.getByText(agent.readerText, { exact: true });
      const originalText = await firstParagraph.evaluateHandle((element) =>
        document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode(),
      );
      try {
        const retained = timeline
          .locator("[data-actual-prompt-row], [data-retained-prompt-row]")
          .filter({ hasText: agent.prompt });
        // No absence assertion: a correct fast acquisition may already have completed.
        await expect(retained).toHaveCount(1);
        await expect(retained).toHaveAttribute("data-prompt-pinned", "true");
        await expect(retained.getByTestId("user-message-bubble")).toBeInViewport();
        await expect(retained.getByTestId("user-message-text")).toHaveText(agent.prompt);
        const flow = await retained
          .locator("[data-actual-prompt-content]")
          .evaluate((body) => Number((body as HTMLElement).dataset.promptFlowHeight));
        expect(flow).toBeGreaterThan(0);
        const retainedId = await retained.evaluate(readActualPromptRowId);
        expect(retainedId).not.toBe(newerId);
        expect(tail.entries.map((entry) => entry.messageId)).not.toContain(retainedId);
        await history.expectSettledWithRequestedPages(0);
        const after = await timeline.evaluate(readColdInitialEdge, ids);
        observations.after = after;
        const evidence = JSON.stringify({
          before,
          after,
          tail,
          accounting: history.readAccounting(),
        });
        expect(after.edgeId, evidence).toBe(answerId);
        expect(after.answer!.marker, evidence).toBe("original");
        expect(after.newer!.marker, evidence).toBe("original");
        expect(after.answer!.text, evidence).toBe(before.answer!.text);
        expect(after.answer!.height, evidence).toBe(before.answer!.height);
        expect(Math.abs(after.answer!.top - before.answer!.top), evidence).toBeLessThanOrEqual(1);
        expect(Math.abs(after.newer!.top - before.newer!.top), evidence).toBeLessThanOrEqual(1);
        expect(
          await firstParagraph.evaluate(
            (element, node) => node !== null && element.contains(node),
            originalText,
          ),
        ).toBe(true);
        expect(history.readAccounting().errors, evidence).toEqual([]);
        expect(history.readAccounting().contextBefore ?? 0, evidence).toBeGreaterThan(0);
        expect(history.readAccounting().contentBefore, evidence).toBeGreaterThan(0);
        expect(history.requestCount(), evidence).toBe(0);
        await expect(page.getByTestId("load-older-history-spinner")).toBeHidden();
        expect(await retained.evaluate(readActualPromptRowId)).toBe(retainedId);
        await expect(retained).toHaveAttribute("data-prompt-pinned", "true");
        expect(
          await retained
            .locator("[data-actual-prompt-content]")
            .evaluate((body) => Number((body as HTMLElement).dataset.promptFlowHeight)),
        ).toBe(flow);
        await expect(answer).toHaveCount(1);
        await expect(newer).toHaveCount(1);
      } finally {
        await originalText.dispose();
      }
    } finally {
      try {
        const timeline = page.getByTestId("agent-chat-scroll").filter({ visible: true });
        if (!page.isClosed() && (await timeline.count()) === 1)
          observations.final = await timeline.evaluate(readRemoteToolRunViewport).catch(() => null);
        await testInfo.attach("cold-initial-context-boundary", {
          body: Buffer.from(
            JSON.stringify(
              {
                observations,
                receipts: observedHistory?.windowPages(),
                accounting: observedHistory?.readAccounting(),
                requested: observedHistory?.requestCount(),
              },
              null,
              2,
            ),
          ),
          contentType: "application/json",
        });
      } finally {
        await agent.cleanup();
      }
    }
  });

  test("stops remote paging after one older page extends the leading tool run", async ({
    page,
  }, testInfo) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        "@paseo:app-settings",
        JSON.stringify({ theme: "dark", accentColor: "blue", toolCallDetailLevel: "overview" }),
      );
    });
    // A new agent has never been opened by this browser: no persisted replica can supply its tail.
    const agent = await seedRemoteToolRunTimeline();
    const observations: Record<string, unknown> = {};
    let observedHistory: Awaited<ReturnType<typeof holdOlderHistoryPages>> | undefined;
    try {
      const history = await holdOlderHistoryPages(page, agent);
      observedHistory = history;
      await openAgentTimeline(page, agent);
      const timeline = page.getByTestId("agent-chat-scroll").filter({ visible: true });
      await expect(timeline.getByTestId("tool-call-group")).toHaveCount(1);
      const reader = timeline.getByText(agent.readerText, { exact: true });
      await expect(reader).toBeAttached();
      await expect.poll(() => history.windowPages().some(isRemoteToolRunTail)).toBe(true);
      const tail = history.windowPages().find(isRemoteToolRunTail)!;
      expect(tail.forwarded).toBe(true);
      expect(tail.hasOlder).toBe(true);
      expect(tail.entries).toHaveLength(40);
      const tailTools = tail.entries.filter((entry) => entry.type === "tool_call");
      expect(tailTools).toHaveLength(39);
      const firstCallId = tailTools[0]!.callId;
      expect(firstCallId).toMatch(/:pagination-tool:82$/);
      const runId = firstCallId!.slice(0, firstCallId!.lastIndexOf(":") + 1);
      expect(tailTools.map((entry) => entry.callId)).toEqual(
        Array.from({ length: 39 }, (_, index) => `${runId}${index + 82}`),
      );
      expect(tail.entries.at(-1)?.type).toBe("assistant_message");
      const initialGroupId = await timeline
        .getByTestId("tool-call-group")
        .evaluate(
          (element) => element.closest<HTMLElement>("[data-history-row-id]")!.dataset.historyRowId!,
        );
      expect(decodeURIComponent(initialGroupId).endsWith(firstCallId!)).toBe(true);

      // Recover the one paint-only USER before any manual history input. Its
      // positive natural body measurement is never an added transcript reservation.
      observations.beforeInitialContext = await timeline.evaluate(readRemoteToolRunViewport);
      await history.expectSettledWithRequestedPages(0);
      const initialRetained = timeline
        .locator("[data-actual-prompt-row], [data-retained-prompt-row]")
        .filter({ hasText: agent.prompt });
      await expect(initialRetained).toHaveCount(1);
      const initialPrompt = await initialRetained.evaluate((row) => {
        const body = row.querySelector<HTMLElement>("[data-actual-prompt-content]")!;
        return {
          id:
            row.getAttribute("data-history-row-id") ?? row.getAttribute("data-retained-prompt-row"),
          flowHeight: Number(body.dataset.promptFlowHeight),
        };
      });
      expect(initialPrompt.flowHeight).toBeGreaterThan(0);
      await waitForTimelineGeometryToSettle(page);
      expect(
        await initialRetained
          .locator("[data-actual-prompt-content]")
          .evaluate((body) => Number((body as HTMLElement).dataset.promptFlowHeight)),
      ).toBe(initialPrompt.flowHeight);
      observations.initial = {
        viewport: await timeline.evaluate(readRemoteToolRunViewport),
        prompt: initialPrompt,
      };
      observations.initialReceipts = JSON.stringify(history.windowPages());
      expect(history.requestCount()).toBe(0);

      await userScrollsTimelineToHistoryStart(page);
      await history.expectRequestedPages(1);
      await expect.poll(() => history.windowPages().filter(isOlderWindowPage).length).toBe(1);
      const older = history.windowPages().find(isOlderWindowPage)!;
      expect(older.forwarded).toBe(false);
      expect(older.epoch).toBe(tail.epoch);
      expect(older.hasOlder).toBe(true);
      expect(older.endSeq).toBeLessThan(tail.startSeq);
      expect(older.entries).toHaveLength(40);
      expect(older.entries.every((entry) => entry.type === "tool_call")).toBe(true);
      expect(older.entries.map((entry) => entry.callId)).toEqual(
        Array.from({ length: 40 }, (_, index) => `${runId}${index + 42}`),
      );
      await expect(reader).toBeInViewport();
      const retained = timeline
        .locator("[data-actual-prompt-row], [data-retained-prompt-row]")
        .filter({ hasText: agent.prompt });
      await expect(retained).toHaveCount(1);
      const before = await reader.evaluate((element) => {
        const viewport = element.closest('[data-testid="agent-chat-scroll"]')!;
        const row = element.closest<HTMLElement>("[data-history-row-id]")!;
        row.dataset.remoteToolRunReader = "original";
        return {
          rowId: row.dataset.historyRowId!,
          text: element.textContent,
          top: element.getBoundingClientRect().top - viewport.getBoundingClientRect().top,
          scrollTop: viewport.scrollTop,
          scrollHeight: viewport.scrollHeight,
          clientHeight: viewport.clientHeight,
        };
      });
      expect(before.rowId).toBe(tail.entries.at(-1)!.messageId);
      expect(before.scrollHeight).toBeGreaterThan(before.clientHeight);
      const promptBefore = await retained.evaluate((row) => {
        row.setAttribute("data-remote-tool-run-prompt", "original");
        const body = row.querySelector<HTMLElement>("[data-actual-prompt-content]")!;
        return {
          id:
            row.getAttribute("data-history-row-id") ?? row.getAttribute("data-retained-prompt-row"),
          flowHeight: Number(body.dataset.promptFlowHeight),
        };
      });
      expect(promptBefore.flowHeight).toBeGreaterThan(0);
      expect(promptBefore.id).toBe(initialPrompt.id);
      expect(promptBefore.flowHeight).toBe(initialPrompt.flowHeight);
      observations.beforeRelease = {
        reader: before,
        prompt: promptBefore,
        viewport: await timeline.evaluate(readRemoteToolRunViewport),
      };
      observations.beforeReleaseReceipts = JSON.stringify(history.windowPages());

      // Release a real canonical page, then deliver no further scroll or keyboard input.
      history.releasePage(1);
      await expect(timeline.getByTestId("tool-call-group")).toHaveCount(1);
      await expect
        .poll(() => timeline.getByTestId("tool-call-group").evaluate(readToolGroupHistoryRowId))
        .not.toBe(initialGroupId);
      const appliedGroupId = await timeline
        .getByTestId("tool-call-group")
        .evaluate(
          (element) => element.closest<HTMLElement>("[data-history-row-id]")!.dataset.historyRowId!,
        );
      expect(decodeURIComponent(appliedGroupId).endsWith(older.entries[0]!.callId!)).toBe(true);
      await waitForTimelineGeometryToSettle(page);
      const after = await reader.evaluate((element) => {
        const viewport = element.closest('[data-testid="agent-chat-scroll"]')!;
        const row = element.closest<HTMLElement>("[data-history-row-id]")!;
        return {
          rowId: row.dataset.historyRowId!,
          marker: row.dataset.remoteToolRunReader,
          text: element.textContent,
          top: element.getBoundingClientRect().top - viewport.getBoundingClientRect().top,
          scrollTop: viewport.scrollTop,
          scrollHeight: viewport.scrollHeight,
          clientHeight: viewport.clientHeight,
        };
      });
      observations.afterRelease = {
        reader: after,
        viewport: await timeline.evaluate(readRemoteToolRunViewport),
      };
      const evidence = JSON.stringify({
        tail,
        older,
        initialGroupId,
        appliedGroupId,
        before,
        after,
        requested: history.requestCount(),
      });
      expect(older.forwarded, evidence).toBe(true);
      expect(after.rowId, evidence).toBe(before.rowId);
      expect(after.marker, evidence).toBe("original");
      expect(after.text, evidence).toBe(before.text);
      expect(Math.abs(after.top - before.top), evidence).toBeLessThanOrEqual(1);
      expect(after.scrollHeight, evidence).toBeGreaterThan(after.clientHeight);
      expect(history.requestCount(), evidence).toBe(1);
      await expect(page.getByTestId("load-older-history-spinner")).toBeHidden();
      await history.expectSettledWithRequestedPages(1);
      expect(history.requestCount(), evidence).toBe(1);
      expect(await retained.evaluate(readActualPromptRowId)).toBe(promptBefore.id);
      await expect(retained).toHaveAttribute("data-remote-tool-run-prompt", "original");
      expect(
        await retained
          .locator("[data-actual-prompt-content]")
          .evaluate((body) => Number((body as HTMLElement).dataset.promptFlowHeight)),
      ).toBe(promptBefore.flowHeight);
      await expect(timeline.locator(`[data-history-row-id="${before.rowId}"]`)).toHaveCount(1);
      history.expectNoRepeatedEntries();
    } finally {
      try {
        const timeline = page.getByTestId("agent-chat-scroll").filter({ visible: true });
        if (!page.isClosed() && (await timeline.count()) === 1) {
          observations.final = await timeline.evaluate(readRemoteToolRunViewport).catch(() => null);
        }
        await testInfo.attach("remote-tool-run-boundary", {
          body: Buffer.from(
            JSON.stringify(
              {
                observations,
                requested: observedHistory?.requestCount(),
                receipts: observedHistory?.windowPages(),
              },
              null,
              2,
            ),
          ),
          contentType: "application/json",
        });
      } finally {
        await agent.cleanup();
      }
    }
  });

  test("keeps visible history anchored when live output grows during a prepend", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const agent = await seedLongMockAgentTimeline({ turns: 80 });
    try {
      const history = await holdOlderHistoryPages(page, agent);
      await openAgentTimeline(page, agent);
      await userScrollsTimelineToHistoryStart(page);
      await history.expectRequestedPages(1);
      const position = await rememberTimelinePromptPosition(page, agent.initialTailOldestPrompt);

      await agent.client.sendAgentMessage(
        agent.agentId,
        "timeline live during held older page: emit 20 coalesced agent stream updates",
      );
      await agent.client.waitForFinish(agent.agentId, 15_000);
      history.releasePage(1);

      await expectTimelinePromptPositionPreserved(page, position);
    } finally {
      await agent.cleanup();
    }
  });

  test("finishes loading an older page while live output continues", async ({ page }) => {
    test.setTimeout(120_000);
    // The live turn streams for thirty minutes, so it is still running at every assertion.
    const agent = await seedLongMockAgentTimeline({ turns: 40, liveTurns: "thirty-minute-stream" });
    try {
      const history = await holdOlderHistoryPages(page, agent);
      await openAgentTimeline(page, agent);
      await userScrollsTimelineToHistoryStart(page);
      await history.expectRequestedPages(1);

      await agent.client.sendAgentMessage(agent.agentId, "keep streaming while history settles");
      await agent.client.waitForAgentUpsert(
        agent.agentId,
        (snapshot) => snapshot.status === "running",
      );
      const timeline = page.locator('[data-testid="agent-chat-scroll"]:visible').first();
      await expect(timeline.getByText("walking through").first()).toBeAttached();
      history.releasePage(1);

      await expect(timeline.getByText(agent.newestOlderPagePrompt, { exact: true })).toBeAttached();
      await expect(page.getByTestId("load-older-history-spinner")).toBeHidden({ timeout: 5_000 });
      const running = await agent.client.fetchAgents({ scope: "active" });
      expect(running.entries.find((entry) => entry.agent.id === agent.agentId)?.agent.status).toBe(
        "running",
      );
    } finally {
      await agent.cleanup();
    }
  });

  test("keeps loading while older pages still leave history start exposed", async ({ page }) => {
    test.setTimeout(120_000);
    const agent = await seedLongMockAgentTimeline({ turns: 80 });
    try {
      await makeLoadedTimelineFitViewport(page);
      const history = await holdOlderHistoryPages(page, agent);
      await openAgentTimeline(page, agent);
      await scrollTimelineToOldestLoadedEdge(page);
      await history.expectRequestedPages(1);
      await expect(page.getByTestId("load-older-history-spinner")).toBeVisible();

      history.releasePage(1);
      await history.expectRequestedPages(2);
      await expectTimelineAtHistoryStart(page);
      await expect(page.getByTestId("load-older-history-spinner")).toBeVisible();
    } finally {
      await agent.cleanup();
    }
  });

  test("keeps complete loaded history reachable after reload", async ({ page }) => {
    test.setTimeout(120_000);
    const agent = await seedLongMockAgentTimeline({ turns: 80 });
    try {
      await openAgentTimeline(page, agent);
      await scrollTimelineUntilOlderHistoryIsReachable(page, agent.oldestPrompt);
      await expectTimelinePromptVisible(page, agent.oldestPrompt);

      const hydration = await holdDaemonHydration(page);
      await reloadAgentTimelineFromPersistedReplica(page, agent);
      hydration.release();
      await scrollTimelineUntilOlderHistoryIsReachable(page, agent.oldestPrompt);

      await expectTimelinePromptVisible(page, agent.oldestPrompt);
    } finally {
      await agent.cleanup();
    }
  });

  test("preserves a live row received before replica hydration", async ({ page }) => {
    test.setTimeout(120_000);
    const agent = await seedLongMockAgentTimeline({ turns: 80 });
    try {
      await openAgentTimeline(page, agent);
      await scrollTimelineUntilOlderHistoryIsReachable(page, agent.oldestPrompt);

      const hydration = await holdBootstrapTimelinePage(page, agent);
      await reloadAgentTimelineFromPersistedReplica(page, agent);
      await hydration.waitForDelayedResponse();
      const livePrompt = await sendLiveTurnBeforeHydration(agent);
      await expectTimelinePromptVisible(page, livePrompt);

      hydration.release();
      await hydration.waitForDelayedCatchUp();
      await expectTimelinePromptVisible(page, livePrompt);
      hydration.releaseCatchUp();
      await scrollTimelineUntilOlderHistoryIsReachable(page, agent.oldestPrompt);
      await expectTimelinePromptVisible(page, agent.oldestPrompt);
      await scrollTimelineToNewestLoadedEdge(page);
      await expectTimelinePromptVisible(page, livePrompt);
    } finally {
      await agent.cleanup();
    }
  });
});
