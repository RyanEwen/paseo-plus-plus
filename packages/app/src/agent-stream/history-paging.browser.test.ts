import React, { act } from "react";
import { userEvent } from "vitest/browser";
import { ActualPromptTestFixture, ACTUAL_PROMPT_ID } from "./actual-prompt-rows.test-fixture";
import { expect, it, vi } from "vitest";
import {
  actualPrompt,
  exactTextNodes,
  readAt,
  settleDisclosurePaint,
} from "./actual-prompt-browser.test-fixture";

it.each(["normal", "virtual"] as const)(
  "preserves the ordinary reading anchor when older history fills a gap after an installed isolated prompt in %s history",
  async (historyPlacement) => {
    const prompt = "Already retained context.";
    const requestOlder = vi.fn(() => true);
    const fixture = actualPrompt(prompt, {
      historyPlacement,
      contextOnlyPrompt: true,
      onNearHistoryStart: requestOlder,
      disableOuterSpacing: false,
      hostWidth: 390,
    });
    await document.fonts.ready;
    const scroll = fixture.host.querySelector<HTMLElement>('[data-testid="agent-chat-scroll"]')!;
    const rowsHost = fixture.host.querySelector<HTMLElement>("[data-stream-rows-host]")!;
    await expect
      .poll(() => rowsHost.querySelectorAll('[data-history-row-id="answer"]').length)
      .toBe(1);
    const answer = rowsHost.querySelector<HTMLElement>('[data-history-row-id="answer"]')!;
    const row = rowsHost.querySelector<HTMLElement>(`[data-history-row-id="${ACTUAL_PROMPT_ID}"]`)!;
    const body = row.querySelector<HTMLElement>("[data-actual-prompt-content]")!;
    const text = answer.querySelector<HTMLElement>('[data-testid="assistant-surrounding-text"]')!;
    const textNode = text.firstChild!;
    const ordinaryText = text.textContent;
    const promptNode = exactTextNodes(row, prompt)[0]!;
    // The virtual path must commit actual row sizes before capturing the reader.
    // Adjacent original row coordinates expose the real allocation, without estimates.
    await expect
      .poll(() =>
        Math.abs(
          rowsHost.getBoundingClientRect().height -
            (answer.getBoundingClientRect().bottom - row.getBoundingClientRect().top),
        ),
      )
      .toBeLessThanOrEqual(1);
    readAt(fixture.host, 0);
    await expect.poll(() => scroll.scrollTop).toBe(0);
    await expect.poll(() => requestOlder.mock.calls.length).toBe(1);
    const anchorTop = () => answer.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
    const before = {
      anchorTop: anchorTop(),
      scrollTop: scroll.scrollTop,
      scrollHeight: scroll.scrollHeight,
      clientHeight: scroll.clientHeight,
      flowHeight: Number(body.dataset.promptFlowHeight),
    };
    expect(before.anchorTop).toBeGreaterThanOrEqual(0);
    expect(before.anchorTop).toBeLessThan(before.clientHeight);
    expect(before.flowHeight).toBeGreaterThan(0);
    expect(
      Array.from(
        rowsHost.querySelectorAll<HTMLElement>("[data-history-row-id]"),
        (item) => item.dataset.historyRowId,
      ),
    ).toEqual([ACTUAL_PROMPT_ID, "answer"]);
    const olderHistory: React.ComponentProps<typeof ActualPromptTestFixture>["olderHistory"] = [
      {
        kind: "assistant_message",
        id: "older-answer-1",
        text: "Earlier answer one",
        timestamp: new Date(0),
      },
      {
        kind: "assistant_message",
        id: "older-answer-2",
        text: "Earlier answer two",
        timestamp: new Date(0),
      },
      {
        kind: "assistant_message",
        id: "older-answer-3",
        text: "Earlier answer three",
        timestamp: new Date(0),
      },
    ];
    fixture.render(true, prompt, true, olderHistory);

    // First behavioral guard: new rows belong before the same ordinary answer,
    // not before the context-only USER, whose natural top remains unchanged.
    await expect.poll(() => Math.abs(anchorTop() - before.anchorTop)).toBeLessThanOrEqual(1);
    const growth = scroll.scrollHeight - before.scrollHeight;
    expect(growth).toBeGreaterThan(before.clientHeight);
    expect(Math.abs(scroll.scrollTop - before.scrollTop - growth)).toBeLessThanOrEqual(1);
    expect(scroll.clientHeight).toBe(before.clientHeight);
    // The ordinary anchor now clears the threshold. No new user input or second
    // main-page request is needed to terminate the original fill operation.
    await expect
      .poll(() => fixture.host.querySelector('[data-testid="load-older-history-spinner"]'))
      .toBeNull();
    expect(requestOlder).toHaveBeenCalledTimes(1);
    expect(fixture.host.querySelector('[data-testid="sticky-prompt-system-feedback"]')).toBeNull();
    expect(rowsHost.querySelector('[data-history-row-id="answer"]') === answer).toBe(true);
    expect(text.firstChild === textNode).toBe(true);
    expect(text.textContent).toBe(ordinaryText);
    expect(rowsHost.querySelector(`[data-history-row-id="${ACTUAL_PROMPT_ID}"]`) === row).toBe(
      true,
    );
    expect(exactTextNodes(row, prompt)).toHaveLength(1);
    expect(exactTextNodes(row, prompt)[0] === promptNode).toBe(true);
    expect(Number(body.dataset.promptFlowHeight)).toBe(before.flowHeight);
    const expectedIds = [ACTUAL_PROMPT_ID, ...olderHistory.map((item) => item.id), "answer"];
    expect(
      Array.from(
        rowsHost.querySelectorAll<HTMLElement>("[data-history-row-id]"),
        (item) => item.dataset.historyRowId,
      ),
    ).toEqual(expectedIds);
    for (const id of expectedIds) {
      expect(rowsHost.querySelectorAll(`[data-history-row-id="${id}"]`)).toHaveLength(1);
    }
  },
);

/** Older rows tall enough to scroll, so the viewport follows output from a real offset. */
function pagedTranscript() {
  const onNearHistoryStart = vi.fn(() => true);
  const olderHistory = Array.from({ length: 30 }, (_, index) => ({
    kind: "user_message" as const,
    id: `older-${index}`,
    text: `Older prompt ${index}`,
    timestamp: new Date(index + 10),
  }));
  const fixture = actualPrompt("Newest", {
    historyPlacement: "normal",
    olderHistory,
    onNearHistoryStart,
  });
  const scroll = fixture.host.querySelector<HTMLElement>('[data-testid="agent-chat-scroll"]')!;
  return { ...fixture, scroll, onNearHistoryStart };
}

/** Sends real browser wheel input until the viewport reaches its start, recording event gaps. */
async function wheelToHistoryStart(scroll: HTMLElement) {
  const gaps: number[] = [];
  let lastWheelAt: number | null = null;
  const recordWheel = () => {
    lastWheelAt = performance.now();
  };
  const recordScroll = (event: Event) => {
    if (event.target === scroll && lastWheelAt !== null) {
      gaps.push(performance.now() - lastWheelAt);
      lastWheelAt = null;
    }
  };
  window.addEventListener("wheel", recordWheel, { capture: true, passive: true });
  window.addEventListener("scroll", recordScroll, { capture: true, passive: true });
  try {
    while (scroll.scrollTop > 0) {
      const before = scroll.scrollTop;
      await userEvent.wheel(scroll, { delta: { y: -400 } });
      await expect.poll(() => scroll.scrollTop < before).toBe(true);
    }
  } finally {
    window.removeEventListener("wheel", recordWheel, { capture: true });
    window.removeEventListener("scroll", recordScroll, { capture: true });
  }
  return gaps;
}

async function settleInitialBottomAnchor(scroll: HTMLElement) {
  await expect.poll(() => scroll.scrollTop).toBeGreaterThan(400);
  await settleDisclosurePaint();
}

it("detaches and requests older history from real wheel input on an idle main thread", async () => {
  const { scroll, onNearHistoryStart } = pagedTranscript();
  await settleInitialBottomAnchor(scroll);

  const gaps = await wheelToHistoryStart(scroll);
  console.info("T72 idle wheel-to-scroll gaps (ms, test listeners)", gaps);

  await expect.poll(() => scroll.style.overflowAnchor).toBe("none");
  await expect.poll(() => onNearHistoryStart.mock.calls.length).toBe(1);
});

// Intervention, not natural scheduling: a test listener blocks the main thread after the app's
// wheel listener. The wheel and its scroll event stay browser-delivered. This shows the viewport's
// behavior under a stalled frame in real Chromium. It does not show that CI took this path.
it("detaches and requests older history when a stalled frame delays the wheel's scroll event", async () => {
  const { scroll, onNearHistoryStart } = pagedTranscript();
  await settleInitialBottomAnchor(scroll);
  const stallMainThread = () => {
    const until = performance.now() + 150;
    while (performance.now() < until) {
      // Busy-wait: a timer would yield and let the browser publish the scroll first.
    }
  };
  document.addEventListener("wheel", stallMainThread, { passive: true });
  let gaps: number[];
  try {
    gaps = await wheelToHistoryStart(scroll);
  } finally {
    document.removeEventListener("wheel", stallMainThread);
  }
  console.info("T72 stalled wheel-to-scroll gaps (ms, test listeners)", gaps);

  // The intervention only counts if it separated the two events past the clock window.
  expect(gaps.length).toBeGreaterThan(0);
  expect(
    gaps.every((gap) => gap > 100),
    JSON.stringify(gaps),
  ).toBe(true);
  await expect.poll(() => scroll.style.overflowAnchor).toBe("none");
  await expect.poll(() => onNearHistoryStart.mock.calls.length).toBe(1);
});

it("re-detaches when one overlay thumb drag returns to the bottom and moves up again", async () => {
  const { host, scroll } = pagedTranscript();
  await settleInitialBottomAnchor(scroll);
  const grab = host.querySelector<HTMLElement>('[data-testid="workspace-overlay-scrollbar-grab"]')!;
  const startY = grab.getBoundingClientRect().top + 4;
  const drag = async (clientY: number) => {
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientY }));
    });
    await settleDisclosurePaint();
  };

  act(() => {
    grab.dispatchEvent(new PointerEvent("pointerdown", { clientY: startY, bubbles: true }));
  });
  await settleDisclosurePaint();
  await drag(startY - 80);
  await expect.poll(() => scroll.style.overflowAnchor).toBe("none");

  // Back to the bottom reattaches through the viewport's own rule.
  await drag(startY);
  await expect.poll(() => scroll.style.overflowAnchor).toBe("auto");

  await drag(startY - 80);
  await expect.poll(() => scroll.style.overflowAnchor).toBe("none");
  act(() => {
    window.dispatchEvent(new PointerEvent("pointerup"));
  });
});
