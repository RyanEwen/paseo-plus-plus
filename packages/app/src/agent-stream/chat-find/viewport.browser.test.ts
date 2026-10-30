import React, { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { userEvent } from "vitest/browser";
import { i18n } from "@/i18n/i18next";
import {
  ActualPromptTestFixture,
  ACTUAL_PROMPT_ID,
  ACTUAL_SUCCESSOR_ID,
} from "./actual-prompt-test-fixture";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createFindViewport } from "./viewport.web";
import { revealFindOccurrence } from "./body-reveal.web";
import { findMessageMatches } from "./ranges.web";
import type { ChatFindProps } from "./types";
import type { StreamViewportHandle } from "../strategy";
import { HISTORY_START_THRESHOLD_PX } from "../history-start-pagination";
import { syncActualPromptPin } from "../actual-prompt-pin.web";
import { Text as NativeText, View, type ViewStyle } from "react-native";
import { QuestionFormCard } from "@/components/question-form-card";
import { deleteAttachments, persistAttachmentFromDataUrl } from "@/attachments/service";

interface Capture {
  occurrence?: { signal: AbortSignal; targetTop(): number | null };
}

function transcript(messageId: string, blocks: string[]): HTMLElement {
  const root = document.createElement("div");
  for (const [index, text] of blocks.entries()) {
    const row = document.createElement("div");
    row.setAttribute("data-history-row-id", `${messageId}:block:${index}`);
    row.setAttribute("data-message-id", messageId);
    row.innerHTML = `<div data-message-text="true"><div data-paseo-markdown-tag="p">${text}</div></div>`;
    root.append(row);
  }
  document.body.append(root);
  return root;
}

function viewport(root: HTMLElement, capture: Capture) {
  const handle: StreamViewportHandle = {
    scrollToBottom() {},
    prepareForViewportChange() {},
    scrollToMessage(_messageId, occurrence) {
      if (occurrence) capture.occurrence = occurrence;
    },
  };
  const bindings: Pick<ChatFindProps, "viewportRef" | "revealLoadedMessage" | "visibleMessageIds"> =
    {
      viewportRef: { current: handle },
      revealLoadedMessage: () => false,
      visibleMessageIds: new Set(["message-1"]),
    };
  return createFindViewport({
    getBindings: () => bindings,
    getRoot: () => root,
    highlightName: "paseo-chat-find-test",
  });
}

afterEach(() => {
  CSS.highlights.delete("paseo-chat-find-test");
  document.body.replaceChildren();
});

it("counts occurrences across every block row of the message", async () => {
  const root = transcript("message-1", ["needle one needle", "no hits", "needle three"]);
  const capture: Capture = {};
  const found = await viewport(root, capture).reveal(
    "message-1",
    "needle",
    2,
    new AbortController().signal,
  );
  expect(found).toEqual({ occurrence: 2, count: 3 });
});

// The settle loop asks for the target position every frame while the viewport moves,
// and rows mount and unmount as it does. A flat index into the message would name a
// different occurrence each time the row set changed; the chosen row owns it instead.
it("keeps the chosen occurrence when an earlier row unmounts mid-scroll", async () => {
  const root = transcript("message-1", ["needle one needle", "needle three"]);
  const capture: Capture = {};
  const found = await viewport(root, capture).reveal(
    "message-1",
    "needle",
    2,
    new AbortController().signal,
  );
  expect(found).toEqual({ occurrence: 2, count: 3 });

  const settled = capture.occurrence?.targetTop();
  expect(settled).toBeTypeOf("number");
  expect(highlightedText()).toEqual(["needle"]);
  expect(highlightedRow()).toBe("message-1:block:1");

  root.firstElementChild?.remove();
  expect(capture.occurrence?.targetTop()).toBeTypeOf("number");
  expect(highlightedRow()).toBe("message-1:block:1");
});

function highlightedRanges(): Range[] {
  const highlight = CSS.highlights.get("paseo-chat-find-test");
  return highlight ? Array.from(highlight).filter((range) => range instanceof Range) : [];
}

function highlightedText(): string[] {
  return highlightedRanges().map((range) => range.toString());
}

function highlightedRow(): string | undefined {
  const row =
    highlightedRanges()[0]?.startContainer.parentElement?.closest<HTMLElement>(
      "[data-history-row-id]",
    );
  return row?.dataset.historyRowId;
}

let actualRoot: Root | null = null;
beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(() => {
  act(() => actualRoot?.unmount());
  actualRoot = null;
  vi.unstubAllGlobals();
});

function actualPrompt(
  text: string,
  options: Pick<
    React.ComponentProps<typeof ActualPromptTestFixture>,
    | "successorText"
    | "lastUserOnly"
    | "images"
    | "historyPlacement"
    | "promptAvailable"
    | "contextOnlyPrompt"
    | "olderHistory"
    | "onNearHistoryStart"
    | "localHistory"
    | "onReadingPositionChange"
    | "disableOuterSpacing"
    | "holdActionsVisible"
    | "onNavigate"
  > & { hostWidth?: number; hostHeight?: number } = {},
) {
  void i18n;
  const { hostWidth = 300, hostHeight = 320, ...fixtureOptions } = options;
  const host = document.createElement("div");
  Object.assign(host.style, { width: `${hostWidth}px`, height: `${hostHeight}px` });
  document.body.append(host);
  const ref = createRef<StreamViewportHandle>();
  actualRoot = createRoot(host);
  function render(
    enabled = true,
    nextText = text,
    promptAvailable = fixtureOptions.promptAvailable,
    olderHistory = fixtureOptions.olderHistory,
  ) {
    act(() =>
      actualRoot!.render(
        React.createElement(ActualPromptTestFixture, {
          ...fixtureOptions,
          promptAvailable,
          olderHistory,
          text: nextText,
          enabled,
          viewportRef: ref,
        }),
      ),
    );
  }
  render();
  return { host, ref, render };
}

function actualPromptGeometry(host: HTMLElement) {
  const scrollElement = host.querySelector<HTMLElement>('[data-testid="agent-chat-scroll"]')!;
  const row = host.querySelector<HTMLElement>(`[data-history-row-id="${ACTUAL_PROMPT_ID}"]`)!;
  const bubble = row.querySelector<HTMLElement>('[data-testid="user-message-bubble"]')!;
  return {
    viewport: scrollElement.getBoundingClientRect().toJSON(),
    originalWrapper: row.getBoundingClientRect().toJSON(),
    bubble: bubble.getBoundingClientRect().toJSON(),
    scrollTop: scrollElement.scrollTop,
    clientHeight: scrollElement.clientHeight,
    scrollHeight: scrollElement.scrollHeight,
    pinned: row.dataset.promptPinned,
    translation: row.dataset.promptTranslation,
  };
}

// Reproduce the caller's rail contract without mounting the daemon-backed AgentStream.
// Both permission and footer callers use this contract. The shared test theme
// omits contentMaxWidth, so use the fixture's explicit 820px rail here.
const auxiliaryRailStyle: ViewStyle = {
  width: "100%",
  maxWidth: 820,
  alignSelf: "center",
  paddingHorizontal: 8,
};

it.each([1200, 360])(
  "centers live auxiliary content on the message rail at %i px",
  async (width) => {
    const host = document.createElement("div");
    Object.assign(host.style, { width: `${width}px`, height: "900px" });
    document.body.append(host);
    actualRoot = createRoot(host);
    const wrapRow = (content: React.ReactNode) =>
      React.createElement(View, { style: auxiliaryRailStyle, testID: "message-rail" }, content);
    const question = React.createElement(
      View,
      { style: auxiliaryRailStyle, testID: "question-rail" },
      React.createElement(QuestionFormCard, {
        permission: {
          key: "alignment-question",
          agentId: "agent",
          request: {
            id: "alignment-question",
            provider: "claude",
            name: "AskUserQuestion",
            kind: "question",
            input: {
              questions: [{ question: "Which provider?", options: [{ label: "Codex" }] }],
            },
          },
        },
        onRespond: vi.fn(),
        isResponding: false,
        responseError: null,
      }),
    );
    const liveAuxiliary = React.createElement(
      React.Fragment,
      null,
      React.createElement(
        View,
        { style: auxiliaryRailStyle, testID: "summary-rail" },
        React.createElement(NativeText, null, "Worked for 1 second"),
      ),
      question,
    );
    await act(async () => {
      actualRoot!.render(
        React.createElement(ActualPromptTestFixture, {
          text: "Keep the question and summary aligned with this message.",
          enabled: false,
          viewportRef: createRef<StreamViewportHandle>(),
          wrapRow,
          liveAuxiliary,
        }),
      );
    });

    const messageRail = host.querySelector<HTMLElement>('[data-testid="message-rail"]')!;
    const questionRail = host.querySelector<HTMLElement>('[data-testid="question-rail"]')!;
    const footerRail = host.querySelector<HTMLElement>('[data-testid="summary-rail"]')!;
    const message = messageRail.getBoundingClientRect();
    const feed = host.querySelector<HTMLElement>('[data-testid="agent-chat-scroll"]')!;
    const feedRect = feed.getBoundingClientRect();

    expect(message.width).toBeCloseTo(Math.min(820, feed.clientWidth - 32), 0);
    expect(message.left + message.width / 2).toBeCloseTo(feedRect.left + feed.clientWidth / 2, 0);
    for (const rail of [footerRail, questionRail]) {
      const bounds = rail.getBoundingClientRect();
      expect(bounds.left).toBeCloseTo(message.left, 0);
      expect(bounds.right).toBeCloseTo(message.right, 0);
    }
    expect(feed.scrollWidth).toBe(feed.clientWidth);
  },
);

function exactTextNodes(root: HTMLElement, text: string): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode()))
    if (node instanceof Text && node.data === text) nodes.push(node);
  return nodes;
}

it("keeps one actual prompt text node through pin, More/Less and settings off/on", async () => {
  const prompt = "First prompt line\nSecond prompt line\nThird prompt line";
  const fixture = actualPrompt(prompt);
  const text = fixture.host.querySelector<HTMLElement>('[data-testid="user-message-text"]')!;
  const node = exactTextNodes(fixture.host, prompt)[0];
  await expect
    .poll(() => fixture.host.querySelector('[data-testid="user-message-disclosure"]'))
    .not.toBeNull();
  expect(exactTextNodes(fixture.host, prompt)).toHaveLength(1);
  expect(fixture.host.querySelector('[data-testid="text-preview-measurement"]')).toBeNull();
  const clip = text.closest<HTMLElement>('[data-testid="text-preview-clip"]')!;
  const lineHeight = Number.parseFloat(getComputedStyle(text).lineHeight);
  expect(clip.getBoundingClientRect().height).toBe(lineHeight);
  await userEvent.click(
    fixture.host.querySelector<HTMLElement>('[data-testid="user-message-disclosure"]')!,
  );
  await expect
    .poll(() => clip.getBoundingClientRect().height)
    .toBe(text.getBoundingClientRect().height);
  const beforeJump = actualPromptGeometry(fixture.host);
  console.info("actual-prompt-before-jump", JSON.stringify(beforeJump));
  expect(beforeJump.clientHeight).toBe(320);
  expect(beforeJump.scrollHeight).toBeGreaterThan(beforeJump.clientHeight);
  try {
    act(() => fixture.ref.current!.scrollToMessage!(ACTUAL_PROMPT_ID, undefined, "pinned"));
    await expect
      .poll(() => fixture.host.querySelector('[data-prompt-pinned="true"]'))
      .not.toBeNull();
  } catch (error) {
    console.info("actual-prompt-jump-failure", JSON.stringify(actualPromptGeometry(fixture.host)));
    throw error;
  }
  expect(fixture.host.querySelector('[data-testid="user-message-text"]') === text).toBe(true);
  expect(
    exactTextNodes(fixture.host, prompt).length === 1 &&
      exactTextNodes(fixture.host, prompt)[0] === node,
  ).toBe(true);
  await userEvent.click(
    fixture.host.querySelector<HTMLElement>('[data-testid="user-message-disclosure"]')!,
  );
  await expect.poll(() => clip.getBoundingClientRect().height).toBe(lineHeight);
  fixture.render(false);
  await expect
    .poll(() => clip.getBoundingClientRect().height)
    .toBe(text.getBoundingClientRect().height);
  expect(
    exactTextNodes(fixture.host, prompt).length === 1 &&
      exactTextNodes(fixture.host, prompt)[0] === node,
  ).toBe(true);
  fixture.render(true);
  await expect.poll(() => clip.getBoundingClientRect().height).toBe(lineHeight);
  expect(
    exactTextNodes(fixture.host, prompt).length === 1 &&
      exactTextNodes(fixture.host, prompt)[0] === node,
  ).toBe(true);
  expect(fixture.host.querySelector('[data-testid="user-message-text"]') === text).toBe(true);
});

it("updates actual prompt More availability from wrapping at the real width", async () => {
  const prompt = "A prompt that fits one wide line but wraps at a narrow width";
  const fixture = actualPrompt(prompt);
  fixture.host.style.width = "1000px";
  await expect
    .poll(() => fixture.host.querySelector('[data-testid="user-message-disclosure"]'))
    .toBeNull();
  const text = fixture.host.querySelector('[data-testid="user-message-text"]');
  fixture.host.style.width = "160px";
  await expect
    .poll(() => fixture.host.querySelector('[data-testid="user-message-disclosure"]'))
    .not.toBeNull();
  expect(fixture.host.querySelector('[data-testid="user-message-text"]') === text).toBe(true);
  expect(exactTextNodes(fixture.host, prompt)).toHaveLength(1);
  fixture.render(true, "Short");
  await expect
    .poll(() => fixture.host.querySelector('[data-testid="user-message-disclosure"]'))
    .toBeNull();
  expect(fixture.host.querySelector('[data-testid="user-message-text"]') === text).toBe(true);
  expect(exactTextNodes(fixture.host, "Short")).toHaveLength(1);
});

it("keeps explicit More's bounded inner reveal and fences cancelled inner writes", async () => {
  const prompt =
    Array.from({ length: 80 }, (_, index) => `Line ${index}`).join("\n") + "\nneedle tail";
  const fixture = actualPrompt(prompt);
  const row = fixture.host.querySelector<HTMLElement>(
    `[data-history-row-id="${ACTUAL_PROMPT_ID}"]`,
  )!;
  const text = fixture.host.querySelector<HTMLElement>('[data-testid="user-message-text"]')!;
  const body = row.querySelector<HTMLElement>('[data-testid="user-message-body-scroll"]')!;
  act(() => fixture.ref.current!.scrollToMessage!(ACTUAL_PROMPT_ID, undefined, "pinned"));
  await expect.poll(() => pinnedPromptIds(fixture.host)).toEqual([ACTUAL_PROMPT_ID]);
  await expect
    .poll(() => row.querySelector('[data-testid="user-message-disclosure"]'))
    .not.toBeNull();
  await userEvent.click(row.querySelector<HTMLElement>('[data-testid="user-message-disclosure"]')!);
  await expect.poll(() => body.dataset.bodyExpanded).toBe("true");
  await expect.poll(() => body.scrollHeight > body.clientHeight).toBe(true);
  const signalOwner = new AbortController();
  const deadline = performance.now() + 5000;
  const range = findMessageMatches(fixture.host, ACTUAL_PROMPT_ID, "needle tail")[0]!;
  const stale = {
    targetTop: () =>
      revealFindOccurrence({
        range,
        row,
        signal: signalOwner.signal,
        deadline,
        clearance: 0,
      }),
  };
  // Explicit More retains its real bounded inner viewport. This exported owner
  // performs the inner reveal without dispatching a new outer-row navigation.
  expect(stale.targetTop()).toBeTypeOf("number");
  await expect.poll(() => body.scrollTop > 0).toBe(true);
  await expect
    .poll(() => {
      const target = range.getBoundingClientRect();
      const inner = body.getBoundingClientRect();
      const outer = fixture.host
        .querySelector('[data-testid="agent-chat-scroll"]')!
        .getBoundingClientRect();
      return (
        target.top >= Math.max(inner.top, outer.top) - 1 &&
        target.bottom <= Math.min(inner.bottom, outer.bottom) + 1
      );
    })
    .toBe(true);
  const deepOffset = body.scrollTop;
  const firstRange = findMessageMatches(fixture.host, ACTUAL_PROMPT_ID, "Line 0")[0]!;
  const latest = {
    targetTop: () =>
      revealFindOccurrence({
        range: firstRange,
        row,
        signal: signalOwner.signal,
        deadline,
        clearance: 0,
      }),
  };
  expect(latest.targetTop()).toBeTypeOf("number");
  await expect.poll(() => body.scrollTop < deepOffset).toBe(true);
  const firstMatch = firstRange.getBoundingClientRect();
  const bodyBounds = body.getBoundingClientRect();
  expect(firstMatch.top).toBeGreaterThanOrEqual(bodyBounds.top);
  expect(firstMatch.bottom).toBeLessThanOrEqual(bodyBounds.bottom);
  expect(fixture.host.querySelector('[data-testid="user-message-text"]') === text).toBe(true);
  expect(exactTextNodes(fixture.host, prompt)).toHaveLength(1);
  signalOwner.abort();
  const innerBefore = body.scrollTop;
  const outer = fixture.host.querySelector<HTMLElement>('[data-testid="agent-chat-scroll"]')!;
  const outerBefore = outer.scrollTop;
  expect(stale.targetTop()).toBeNull();
  expect(latest.targetTop()).toBeNull();
  expect(body.scrollTop).toBe(innerBefore);
  expect(outer.scrollTop).toBe(outerBefore);
  await userEvent.click(row.querySelector<HTMLElement>('[data-testid="user-message-disclosure"]')!);
  await expect.poll(() => body.dataset.bodyExpanded).toBe("false");
});

it("reveals a deep actual user match in its ordinary original row and fences stale viewport writes", async () => {
  const prompt =
    Array.from({ length: 80 }, (_, index) => `Line ${index}`).join("\n") + "\nneedle tail";
  const fixture = actualPrompt(prompt);
  const text = fixture.host.querySelector<HTMLElement>('[data-testid="user-message-text"]')!;
  await expect
    .poll(() => fixture.host.querySelector('[data-testid="user-message-disclosure"]'))
    .not.toBeNull();
  const body = fixture.host.querySelector<HTMLElement>('[data-testid="user-message-body-scroll"]')!;
  expect(body.dataset.bodyExpanded).toBe("false");
  expect(body.contains(fixture.host.querySelector('[data-testid="user-message-disclosure"]'))).toBe(
    false,
  );
  expect(body.contains(fixture.host.querySelector('[data-testid="user-message-next"]'))).toBe(
    false,
  );
  act(() => fixture.ref.current!.scrollToMessage!(ACTUAL_PROMPT_ID, undefined, "pinned"));
  await expect.poll(() => fixture.host.querySelector('[data-prompt-pinned="true"]')).not.toBeNull();
  const handle = fixture.ref.current!;
  const originalScroll = handle.scrollToMessage!;
  const operations: NonNullable<Capture["occurrence"]>[] = [];
  handle.scrollToMessage = (id, occurrence, placement) => {
    if (occurrence) operations.push(occurrence);
    originalScroll(id, occurrence, placement);
  };
  const find = createFindViewport({
    getBindings: () => ({
      viewportRef: fixture.ref,
      revealLoadedMessage: () => true,
      visibleMessageIds: new Set([ACTUAL_PROMPT_ID]),
    }),
    getRoot: () => fixture.host,
    highlightName: "paseo-chat-find-test",
  });
  const first = new AbortController();
  await find.reveal(ACTUAL_PROMPT_ID, "needle tail", 0, first.signal);
  await expect.poll(() => body.dataset.bodyExpanded).toBe("true");
  await expect
    .poll(() => {
      const range = highlightedRanges()[0]?.getBoundingClientRect();
      const inner = body.getBoundingClientRect();
      const outer = fixture.host
        .querySelector('[data-testid="agent-chat-scroll"]')!
        .getBoundingClientRect();
      return (
        !!range &&
        // Chromium quantizes scrollTop while DOMRect keeps fractional CSS pixels.
        range.top >= Math.max(inner.top, outer.top) - 1 &&
        range.bottom <= Math.min(inner.bottom, outer.bottom) + 1
      );
    })
    .toBe(true);
  expect(fixture.host.querySelector('[data-testid="user-message-text"]') === text).toBe(true);
  expect(exactTextNodes(fixture.host, prompt)).toHaveLength(1);
  const stale = operations[0]!;
  expectPreparedDisclosureHidden(text.closest<HTMLElement>("[data-history-row-id]")!);
  find.clear();
  await readAtPromptHandoff(fixture.host);
  await expect.poll(() => pinnedPromptIds(fixture.host)).toEqual([ACTUAL_PROMPT_ID]);
  await expect.poll(() => body.dataset.bodyExpanded).toBe("false");
  const aborted = new AbortController();
  aborted.abort();
  await expect(find.reveal(ACTUAL_PROMPT_ID, "Line 0", 0, aborted.signal)).rejects.toThrow(
    "Search cancelled",
  );
  expect(body.dataset.bodyExpanded).toBe("false");
  const superseded = new AbortController();
  const supersededReveal = find.reveal(ACTUAL_PROMPT_ID, "needle tail", 0, superseded.signal);
  find.clear();
  await expect(supersededReveal).rejects.toThrow("Search cancelled");
  expect(body.dataset.bodyExpanded).toBe("false");
  const second = new AbortController();
  await find.reveal(ACTUAL_PROMPT_ID, "Line 0", 0, second.signal);
  await expect.poll(() => body.dataset.bodyExpanded).toBe("true");
  await expect.poll(highlightedText).toEqual(["Line 0"]);
  const firstMatch = highlightedRanges()[0]!.getBoundingClientRect();
  const bodyBounds = body.getBoundingClientRect();
  expect(firstMatch.top).toBeGreaterThanOrEqual(bodyBounds.top);
  expect(firstMatch.bottom).toBeLessThanOrEqual(bodyBounds.bottom);
  const innerBefore = body.scrollTop;
  const outer = fixture.host.querySelector<HTMLElement>('[data-testid="agent-chat-scroll"]')!;
  const outerBefore = outer.scrollTop;
  expect(stale.targetTop()).toBeNull();
  expect(body.scrollTop).toBe(innerBefore);
  expect(outer.scrollTop).toBe(outerBefore);
  first.abort();
  second.abort();
  const latest = operations.at(-1)!;
  expect(latest.targetTop()).toBeNull();
  expect(body.scrollTop).toBe(innerBefore);
  expect(outer.scrollTop).toBe(outerBefore);
});

it("keeps surrounding chat painted and interactive outside the opaque actual prompt allocation", async () => {
  const fixture = actualPrompt("Short");
  const scroll = fixture.host.querySelector<HTMLElement>('[data-testid="agent-chat-scroll"]')!;
  const body = fixture.host.querySelector<HTMLElement>("[data-actual-prompt-content]")!;
  const row = fixture.host.querySelector<HTMLElement>(
    `[data-history-row-id="${ACTUAL_PROMPT_ID}"]`,
  )!;
  const bubble = body.querySelector<HTMLElement>('[data-testid="user-message-bubble"]')!;
  const trailing = body.querySelector<HTMLElement>('[data-testid="user-message-trailing-row"]')!;
  const target = fixture.host.querySelector<HTMLButtonElement>(
    '[data-testid="assistant-surrounding-target"]',
  )!;
  const originalBody = body;
  const originalText = bubble.querySelector('[data-testid="user-message-text"]');
  const viewportTop = scroll.getBoundingClientRect().top;
  const targetTop = target.getBoundingClientRect().top - viewportTop + scroll.scrollTop;
  act(() => {
    // Match the strategy fixture's user intent before positioning a detached reading viewport.
    scroll.dispatchEvent(new WheelEvent("wheel", { deltaY: -240 }));
    scroll.scrollTop = targetTop - 8;
    scroll.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(() => row.dataset.promptPinned).toBe("true");
  const bodyBox = body.getBoundingClientRect();
  const bubbleBox = bubble.getBoundingClientRect();
  const targetBox = target.getBoundingClientRect();
  const point = { x: targetBox.left + 8, y: targetBox.top + 8 };
  expect(point.x).toBeLessThan(bubbleBox.left);
  expect(point.y).toBeGreaterThanOrEqual(bodyBox.top);
  expect(point.y).toBeLessThan(bodyBox.bottom);
  expect(document.elementFromPoint(point.x, point.y) === target).toBe(true);
  expect(getComputedStyle(body).backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expect(getComputedStyle(body).pointerEvents).toBe("none");
  expect(getComputedStyle(bubble).backgroundColor).toMatch(/^rgb\(/);
  expect(getComputedStyle(bubble).pointerEvents).toBe("auto");
  const backdrop = trailing.firstElementChild;
  expect(backdrop).toBeInstanceOf(HTMLElement);
  expect(getComputedStyle(backdrop!).backgroundColor).toMatch(/^rgb\(/);
  expect(getComputedStyle(trailing).paddingTop).toBe("8px");
  expect(getComputedStyle(trailing).paddingRight).toBe("8px");
  expect(getComputedStyle(trailing).paddingBottom).toBe("8px");
  expect(getComputedStyle(trailing).paddingLeft).toBe("8px");
  const beforeClick = scroll.scrollTop;
  await userEvent.click(target);
  expect(target.textContent).toBe("Response 1");
  expect(scroll.scrollTop).toBe(beforeClick);
  expect(fixture.host.querySelector("[data-actual-prompt-content]") === originalBody).toBe(true);
  expect(bubble.querySelector('[data-testid="user-message-text"]') === originalText).toBe(true);
  const answerText = fixture.host.querySelector<HTMLElement>(
    '[data-testid="assistant-surrounding-text"]',
  )!;
  const selection = window.getSelection()!;
  const range = document.createRange();
  range.selectNodeContents(answerText);
  selection.removeAllRanges();
  selection.addRange(range);
  expect(selection.toString()).toBe("Selectable surrounding answer");
  selection.removeAllRanges();
});

it("waits for an asynchronous renderer before counting its matches", async () => {
  const root = transcript("message-1", ["needle"]);
  const content = root.querySelector('[data-message-text="true"]')!;
  content.setAttribute("aria-busy", "true");
  let settled = false;
  const reveal = viewport(root, {})
    .reveal("message-1", "needle", 0, new AbortController().signal)
    .then((result) => {
      settled = true;
      return result;
    });
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  expect(settled).toBe(false);
  content.textContent = "needle and another needle";
  content.removeAttribute("aria-busy");
  expect(await reveal).toEqual({ occurrence: 0, count: 2 });
});

/** Read the untransformed row wrappers, not the CSS-sticky painted child. The
 * following answer exposes the first prompt's actual normal-flow reservation.
 */
function naturalPromptFlow(host: HTMLElement) {
  const scroll = host.querySelector<HTMLElement>('[data-testid="agent-chat-scroll"]')!;
  const origin = scroll.getBoundingClientRect().top;
  const top = (id: string) =>
    host.querySelector<HTMLElement>(`[data-history-row-id="${id}"]`)!.getBoundingClientRect().top -
    origin +
    scroll.scrollTop;
  const promptTop = top(ACTUAL_PROMPT_ID);
  return {
    promptTop,
    flowHeight: top("answer") - promptTop,
    successorTop: top(ACTUAL_SUCCESSOR_ID),
    scrollHeight: scroll.scrollHeight,
  };
}

/** Capture real glyph layout relative to its persistent Text element. Clipping
 * or inner scrolling may move it, but must not change wrapping or glyph widths.
 */
function naturalPromptText(text: HTMLElement, node: Text) {
  const bounds = text.getBoundingClientRect();
  const range = document.createRange();
  range.selectNodeContents(node);
  return {
    width: bounds.width,
    height: bounds.height,
    lines: Array.from(range.getClientRects(), (rect) => ({
      x: rect.left - bounds.left,
      y: rect.top - bounds.top,
      width: rect.width,
      height: rect.height,
    })),
  };
}

function pinnedPromptIds(host: HTMLElement) {
  return Array.from(
    host.querySelectorAll<HTMLElement>('[data-actual-prompt-row][data-prompt-pinned="true"]'),
    (row) => row.dataset.historyRowId,
  );
}

/** Use the existing manual-reading admission before positioning the real outer
 * scroll owner. No layout values or renderer measurements are substituted.
 */
function readAt(host: HTMLElement, top: number) {
  const scroll = host.querySelector<HTMLElement>('[data-testid="agent-chat-scroll"]')!;
  act(() => {
    scroll.dispatchEvent(new WheelEvent("wheel", { deltaY: -240 }));
    scroll.scrollTop = top;
    scroll.dispatchEvent(new Event("scroll"));
  });
}

/** Correspondence setup only: the independent tail-boundary case measures
 * actual compact DOM paint. No expected allocation or coordinate is substituted.
 */
function qualifiedPromptThreshold(host: HTMLElement, id = ACTUAL_PROMPT_ID): number | null {
  const scroll = host.querySelector<HTMLElement>('[data-testid="agent-chat-scroll"]');
  const row = host.querySelector<HTMLElement>(`[data-history-row-id="${id}"]`);
  const body = row?.querySelector<HTMLElement>("[data-actual-prompt-content]");
  const flow = Number(body?.dataset.promptFlowHeight);
  const compact = Number(body?.dataset.promptCompactHeight);
  if (
    !scroll ||
    !row ||
    !body ||
    !(flow > 0) ||
    !(compact > 0) ||
    !Number.isFinite(flow) ||
    !Number.isFinite(compact)
  )
    return null;
  return (
    row.getBoundingClientRect().top -
    scroll.getBoundingClientRect().top +
    scroll.scrollTop +
    Math.max(0, flow - compact)
  );
}

async function readAtPromptHandoff(host: HTMLElement, id = ACTUAL_PROMPT_ID) {
  await expect.poll(() => qualifiedPromptThreshold(host, id)).not.toBeNull();
  const threshold = qualifiedPromptThreshold(host, id);
  if (threshold === null) throw new Error("The actual prompt has no qualified handoff geometry");
  readAt(host, threshold + 1);
}

/** Ordinary More remains prepared for measurement, unavailable to paint, input
 * and accessibility. Inert focus rejection proves more than DOM presence alone.
 */
function expectPreparedDisclosureHidden(row: HTMLElement) {
  const control = row.querySelector<HTMLElement>('[data-testid="user-message-disclosure"]');
  expect(control).not.toBeNull();
  const panel = control!.parentElement!;
  expect(panel.getAttribute("aria-hidden")).toBe("true");
  expect(panel.inert).toBe(true);
  expect(getComputedStyle(control!).visibility).toBe("hidden");
  const active = document.activeElement;
  control!.focus();
  expect(document.activeElement).toBe(active);
}

it("preserves natural prompt flow and wrapping through real successor pin collision and disclosure", async () => {
  const prompt = Array.from(
    { length: 32 },
    (_, index) =>
      `Paragraph ${index}: ordinary wrapping remains the same when this actual message becomes sticky.`,
  ).join("\n");
  const successor = "A distinct real successor prompt";
  const fixture = actualPrompt(prompt, { successorText: successor });
  await document.fonts.ready;
  const row = fixture.host.querySelector<HTMLElement>(
    `[data-history-row-id="${ACTUAL_PROMPT_ID}"]`,
  )!;
  const nextRow = fixture.host.querySelector<HTMLElement>(
    `[data-history-row-id="${ACTUAL_SUCCESSOR_ID}"]`,
  )!;
  const scroll = fixture.host.querySelector<HTMLElement>('[data-testid="agent-chat-scroll"]')!;
  readAt(fixture.host, naturalPromptFlow(fixture.host).promptTop - 8);
  await expect.poll(() => pinnedPromptIds(fixture.host)).toEqual([]);
  const text = row.querySelector<HTMLElement>('[data-testid="user-message-text"]')!;
  const node = exactTextNodes(row, prompt)[0]!;
  const ordinaryFlow = naturalPromptFlow(fixture.host);
  const ordinaryText = naturalPromptText(text, node);
  expect(ordinaryFlow.flowHeight).toBeGreaterThan(scroll.clientHeight);
  expect(ordinaryText.lines.length).toBeGreaterThan(32);
  expect(ordinaryText.height).toBeGreaterThan(scroll.clientHeight);

  const assertNaturalBody = async (owners: string[]) => {
    await expect
      .poll(() => ({
        flow: naturalPromptFlow(fixture.host),
        owners: pinnedPromptIds(fixture.host),
      }))
      .toEqual({ flow: ordinaryFlow, owners });
    expect(row.querySelector('[data-testid="user-message-text"]') === text).toBe(true);
    expect(
      exactTextNodes(fixture.host, prompt).length === 1 &&
        exactTextNodes(fixture.host, prompt)[0] === node,
    ).toBe(true);
    expect(exactTextNodes(fixture.host, successor)).toHaveLength(1);
    expect(
      fixture.host.querySelectorAll(`[data-history-row-id="${ACTUAL_PROMPT_ID}"]`),
    ).toHaveLength(1);
    expect(
      fixture.host.querySelectorAll(`[data-history-row-id="${ACTUAL_SUCCESSOR_ID}"]`),
    ).toHaveLength(1);
    expect(naturalPromptText(text, node)).toEqual(ordinaryText);
  };

  await readAtPromptHandoff(fixture.host);
  await expect.poll(() => pinnedPromptIds(fixture.host)).toEqual([ACTUAL_PROMPT_ID]);
  const body = row.querySelector<HTMLElement>("[data-actual-prompt-content]")!;
  const inner = row.querySelector<HTMLElement>('[data-testid="user-message-body-scroll"]')!;
  const clip = text.closest<HTMLElement>('[data-testid="text-preview-clip"]')!;
  const disclosure = () =>
    row.querySelector<HTMLElement>('[data-testid="user-message-disclosure"]')!;
  await expect.poll(() => disclosure()).not.toBeNull();
  await expect.poll(() => inner.dataset.bodyExpanded).toBe("false");
  await assertNaturalBody([ACTUAL_PROMPT_ID]);
  const lineHeight = Number.parseFloat(getComputedStyle(text).lineHeight);
  expect(clip.getBoundingClientRect().height).toBe(lineHeight);
  expect(body.getBoundingClientRect().height).toBeLessThan(ordinaryFlow.flowHeight);

  await userEvent.click(disclosure());
  await expect.poll(() => inner.dataset.bodyExpanded).toBe("true");
  await expect.poll(() => inner.scrollHeight > inner.clientHeight).toBe(true);
  await assertNaturalBody([ACTUAL_PROMPT_ID]);
  expect(body.getBoundingClientRect().height).toBeLessThan(ordinaryFlow.flowHeight);
  expect(body.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    scroll.getBoundingClientRect().bottom,
  );
  const outerBefore = scroll.scrollTop;
  act(() => {
    inner.scrollTop = inner.scrollHeight - inner.clientHeight;
    inner.dispatchEvent(new Event("scroll"));
  });
  expect(inner.scrollTop).toBeGreaterThan(0);
  expect(scroll.scrollTop).toBe(outerBefore);
  await assertNaturalBody([ACTUAL_PROMPT_ID]);

  await userEvent.click(disclosure());
  await expect.poll(() => inner.dataset.bodyExpanded).toBe("false");
  await expect.poll(() => clip.getBoundingClientRect().height).toBe(lineHeight);
  await assertNaturalBody([ACTUAL_PROMPT_ID]);
  const compactHeight = body.getBoundingClientRect().height;
  readAt(fixture.host, ordinaryFlow.successorTop - compactHeight / 2);
  await expect.poll(() => pinnedPromptIds(fixture.host)).toEqual([ACTUAL_PROMPT_ID]);
  // Collision uses the bounded painted extent, not the full natural reservation.
  await expect
    .poll(() => body.getBoundingClientRect().bottom)
    .toBe(nextRow.getBoundingClientRect().top);
  expect(body.getBoundingClientRect().top).toBeLessThan(scroll.getBoundingClientRect().top);
  await assertNaturalBody([ACTUAL_PROMPT_ID]);

  await readAtPromptHandoff(fixture.host, ACTUAL_SUCCESSOR_ID);
  await expect.poll(() => pinnedPromptIds(fixture.host)).toEqual([ACTUAL_SUCCESSOR_ID]);
  await assertNaturalBody([ACTUAL_SUCCESSOR_ID]);
  readAt(fixture.host, ordinaryFlow.promptTop - 8);
  await expect.poll(() => pinnedPromptIds(fixture.host)).toEqual([]);
  await expect
    .poll(() => clip.getBoundingClientRect().height)
    .toBe(text.getBoundingClientRect().height);
  expectPreparedDisclosureHidden(row);
  await assertNaturalBody([]);
});

it("preserves Attached sample glyph allocation beside real attachment and disclosure controls", async () => {
  const canvas = document.createElement("canvas");
  canvas.width = 2;
  canvas.height = 2;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#356bd8";
  context.fillRect(0, 0, canvas.width, canvas.height);
  const image = await persistAttachmentFromDataUrl({
    dataUrl: canvas.toDataURL("image/png"),
    fileName: "sample.png",
  });
  try {
    const prompt = "Attached sample.";
    const fixture = actualPrompt(prompt, {
      successorText: "Following attachment response",
      images: [image],
    });
    fixture.host.style.width = "390px";
    await document.fonts.ready;
    const row = fixture.host.querySelector<HTMLElement>(
      `[data-history-row-id="${ACTUAL_PROMPT_ID}"]`,
    )!;
    readAt(fixture.host, naturalPromptFlow(fixture.host).promptTop - 8);
    await expect.poll(() => pinnedPromptIds(fixture.host)).toEqual([]);
    // Exercise the actual persisted PNG and thumbnail loader, not fabricated metadata.
    await expect
      .poll(() =>
        Array.from(row.querySelectorAll("img")).some(
          (thumbnail) => thumbnail.complete && thumbnail.naturalWidth === 2,
        ),
      )
      .toBe(true);
    const text = row.querySelector<HTMLElement>('[data-testid="user-message-text"]')!;
    const node = exactTextNodes(row, prompt)[0]!;
    const ordinaryText = naturalPromptText(text, node);
    const ordinaryFlow = naturalPromptFlow(fixture.host);
    expect(ordinaryText.lines).toHaveLength(1);
    const disclosure = () =>
      row.querySelector<HTMLElement>('[data-testid="user-message-disclosure"]')!;
    await readAtPromptHandoff(fixture.host);
    await expect.poll(() => pinnedPromptIds(fixture.host)).toEqual([ACTUAL_PROMPT_ID]);
    await expect.poll(() => disclosure()).not.toBeNull();
    expect(row.querySelector('[data-testid="user-message-attachments-summary"]')).toBeNull();
    await expect.poll(() => naturalPromptFlow(fixture.host)).toEqual(ordinaryFlow);
    expect(row.querySelector('[data-testid="user-message-text"]') === text).toBe(true);
    expect(
      exactTextNodes(fixture.host, prompt).length === 1 &&
        exactTextNodes(fixture.host, prompt)[0] === node,
    ).toBe(true);
    expect(naturalPromptText(text, node)).toEqual(ordinaryText);
    const glyphs = document.createRange();
    glyphs.selectNodeContents(node);
    const glyphBounds = glyphs.getBoundingClientRect();
    const clip = text
      .closest<HTMLElement>('[data-testid="text-preview-clip"]')!
      .getBoundingClientRect();
    expect(glyphBounds.left).toBeGreaterThanOrEqual(clip.left);
    expect(glyphBounds.right).toBeLessThanOrEqual(clip.right);
    expect(glyphBounds.top).toBeGreaterThanOrEqual(clip.top);
    expect(glyphBounds.bottom).toBeLessThanOrEqual(clip.bottom);
    expectOpaqueControlBacking(row, disclosure().getBoundingClientRect());

    await userEvent.click(disclosure());
    await expect
      .poll(() =>
        row
          .querySelector('[data-testid="user-message-body-scroll"]')
          ?.getAttribute("data-body-expanded"),
      )
      .toBe("true");
    await expect
      .poll(() =>
        Array.from(row.querySelectorAll("img")).some(
          (thumbnail) => thumbnail.complete && thumbnail.naturalWidth === 2,
        ),
      )
      .toBe(true);
    const openImage = Array.from(row.querySelectorAll<HTMLElement>('[role="button"]')).find(
      (button) => button.getAttribute("aria-label") === i18n.t("composer.attachments.openImage"),
    )!;
    expect(openImage.getBoundingClientRect().height).toBeGreaterThan(0);
    expect(getComputedStyle(openImage).pointerEvents).toBe("auto");
    expect(naturalPromptFlow(fixture.host)).toEqual(ordinaryFlow);
    expect(naturalPromptText(text, node)).toEqual(ordinaryText);
    await userEvent.click(disclosure());
    await expect
      .poll(() =>
        row
          .querySelector('[data-testid="user-message-body-scroll"]')
          ?.getAttribute("data-body-expanded"),
      )
      .toBe("false");
    expect(naturalPromptFlow(fixture.host)).toEqual(ordinaryFlow);
    expect(naturalPromptText(text, node)).toEqual(ordinaryText);
    readAt(fixture.host, ordinaryFlow.promptTop - 8);
    await expect.poll(() => pinnedPromptIds(fixture.host)).toEqual([]);
    expect(
      exactTextNodes(fixture.host, prompt).length === 1 &&
        exactTextNodes(fixture.host, prompt)[0] === node,
    ).toBe(true);
    expect(naturalPromptFlow(fixture.host)).toEqual(ordinaryFlow);
    expect(naturalPromptText(text, node)).toEqual(ordinaryText);
  } finally {
    act(() => actualRoot?.unmount());
    actualRoot = null;
    await deleteAttachments([image]);
  }
});

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

it.each(["normal", "virtual"] as const)(
  "preserves the visible assistant when a retained prompt arrives in %s history",
  async (historyPlacement) => {
    const prompt = "A retained prompt.";
    const fixture = actualPrompt(prompt, {
      historyPlacement,
      promptAvailable: false,
      disableOuterSpacing: false,
    });
    await document.fonts.ready;
    const scroll = fixture.host.querySelector<HTMLElement>('[data-testid="agent-chat-scroll"]')!;
    const host = fixture.host.querySelector<HTMLElement>("[data-stream-rows-host]")!;
    await expect.poll(() => host.querySelectorAll('[data-history-row-id="answer"]').length).toBe(1);
    const answer = fixture.host.querySelector<HTMLElement>('[data-history-row-id="answer"]')!;
    const text = answer.querySelector<HTMLElement>('[data-testid="assistant-surrounding-text"]')!;
    const textNode = text.firstChild!;
    const answerText = text.textContent;
    // In the virtual variant, wait for the real answer to replace its estimate.
    // No dimensions are supplied to the virtualizer or any DOM measurement API.
    await expect
      .poll(() => host.getBoundingClientRect().height - answer.getBoundingClientRect().height)
      .toBe(0);
    readAt(fixture.host, 0);
    await expect.poll(() => scroll.scrollTop).toBe(0);
    const originalAnchor = () =>
      answer.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
    const before = {
      scrollTop: scroll.scrollTop,
      scrollHeight: scroll.scrollHeight,
      clientHeight: scroll.clientHeight,
      anchorTop: originalAnchor(),
    };
    expect(before.anchorTop).toBeGreaterThanOrEqual(0);
    expect(before.anchorTop).toBeLessThan(scroll.clientHeight);
    expect(
      Array.from(
        host.querySelectorAll<HTMLElement>("[data-history-row-id]"),
        (row) => row.dataset.historyRowId,
      ),
    ).toEqual(["answer"]);
    expect(exactTextNodes(fixture.host, prompt)).toHaveLength(0);

    fixture.render(true, prompt, true);
    await expect.poll(() => pinnedPromptIds(fixture.host)).toEqual([ACTUAL_PROMPT_ID]);
    const row = fixture.host.querySelector<HTMLElement>(
      `[data-history-row-id="${ACTUAL_PROMPT_ID}"]`,
    )!;
    const body = row.querySelector<HTMLElement>("[data-actual-prompt-content]")!;
    // Adjacent original wrapper coordinates independently expose the allocation
    // actually used by both normal flow and committed virtual item positions.
    const allocation = () => answer.getBoundingClientRect().top - row.getBoundingClientRect().top;
    await expect.poll(allocation).toBeGreaterThan(0);
    await expect
      .poll(() =>
        Math.max(
          Math.abs(scroll.scrollHeight - before.scrollHeight - allocation()),
          Math.abs(scroll.scrollTop - before.scrollTop - allocation()),
          Math.abs(originalAnchor() - before.anchorTop),
        ),
      )
      .toBeLessThanOrEqual(1);
    expect(scroll.clientHeight).toBe(before.clientHeight);
    expect(row.getAttribute("data-index")).toBe(historyPlacement === "virtual" ? "0" : null);
    expect(
      Array.from(
        host.querySelectorAll<HTMLElement>("[data-history-row-id]"),
        (item) => item.dataset.historyRowId,
      ),
    ).toEqual([ACTUAL_PROMPT_ID, "answer"]);
    expect(fixture.host.querySelector('[data-history-row-id="answer"]') === answer).toBe(true);
    expect(text.firstChild === textNode).toBe(true);
    expect(text.textContent).toBe(answerText);
    expect(exactTextNodes(fixture.host, prompt)).toHaveLength(1);
    expect(
      fixture.host.querySelectorAll(`[data-history-row-id="${ACTUAL_PROMPT_ID}"]`),
    ).toHaveLength(1);
    expect(fixture.host.querySelectorAll('[data-history-row-id="answer"]')).toHaveLength(1);

    const bodyHeight = body.getBoundingClientRect().height;
    const flow = Number(body.dataset.promptFlowHeight);
    const visual = Number(body.dataset.promptVisualHeight);
    expect(flow).toBeGreaterThan(0);
    expect(visual).toBeGreaterThan(0);
    // The published inner flow plus real caller chrome must agree with the
    // independent adjacent-row allocation, never merely with the painted body.
    expect(Math.abs(flow + bodyHeight - visual - allocation())).toBeLessThanOrEqual(1);
    expect(Math.abs(bodyHeight - allocation())).toBeGreaterThan(1);
    if (historyPlacement === "normal") {
      const style = getComputedStyle(row);
      const outerAllocation =
        row.getBoundingClientRect().height +
        Number.parseFloat(style.marginTop) +
        Number.parseFloat(style.marginBottom);
      expect(Math.abs(outerAllocation - allocation())).toBeLessThanOrEqual(1);
    }
  },
);

/** Verify the actual opaque rectangle allowed to cover this unchanged text frame. */
function expectOpaqueControlBacking(row: HTMLElement, control: DOMRect) {
  const backing = row.querySelector<HTMLElement>(
    '[data-user-message-compact-occlusion="controls"]',
  )!;
  expect(backing).not.toBeNull();
  const occlusion = backing.getBoundingClientRect();
  expect(occlusion.x).toBe(control.x);
  expect(occlusion.y).toBe(control.y);
  expect(occlusion.width).toBe(control.width);
  expect(occlusion.height).toBe(control.height);
  expect(occlusion.toJSON()).toEqual(control.toJSON());
  expect(getComputedStyle(backing).backgroundColor).toMatch(/^rgb\(/);
  const backingStyle = getComputedStyle(backing);
  expect([
    backingStyle.borderTopLeftRadius,
    backingStyle.borderTopRightRadius,
    backingStyle.borderBottomRightRadius,
    backingStyle.borderBottomLeftRadius,
  ]).toEqual(["0px", "0px", "0px", "0px"]);
}

/** Await the public flow/visual publication for the current real DOM layout.
 * Ownership alone can precede the measurement hook's layout publication. This
 * gate never requires the frame, glyph or attachment-center outcome under test.
 */
async function expectCurrentPromptGeometry(host: HTMLElement) {
  const row = host.querySelector<HTMLElement>(`[data-history-row-id="${ACTUAL_PROMPT_ID}"]`)!;
  const body = row.querySelector<HTMLElement>("[data-actual-prompt-content]")!;
  const bubble = row.querySelector<HTMLElement>('[data-testid="user-message-bubble"]')!;
  const actions = row.querySelector<HTMLElement>('[data-testid="user-message-trailing-row"]')!;
  let rail = bubble.parentElement;
  while (rail && !rail.contains(actions)) rail = rail.parentElement;
  if (!rail || !body.contains(rail)) throw new Error("Expected the actual prompt flow rail");
  const currentRail = rail;
  await expect
    .poll(() => {
      const flow = Number(body.dataset.promptFlowHeight);
      const visual = Number(body.dataset.promptVisualHeight);
      const actualVisual = currentRail.getBoundingClientRect().height;
      const style = getComputedStyle(row);
      const allocated =
        row.getBoundingClientRect().height +
        Number.parseFloat(style.marginTop) +
        Number.parseFloat(style.marginBottom);
      const caller = body.getBoundingClientRect().height - actualVisual;
      return (
        Number.isFinite(flow) &&
        flow > 0 &&
        Number.isFinite(visual) &&
        visual > 0 &&
        visual === actualVisual &&
        allocated === flow + caller
      );
    })
    .toBe(true);
}

it("preserves the absolute three-line bubble and first-line glyph frame through the tail handoff", async () => {
  const prompt = "Actual row identity\nSecond rendered line\nThird rendered line";
  const fixture = actualPrompt(prompt, {
    successorText: "Following frame control",
    hostWidth: 820,
  });
  await document.fonts.ready;
  const row = fixture.host.querySelector<HTMLElement>(
    `[data-history-row-id="${ACTUAL_PROMPT_ID}"]`,
  )!;
  const scroll = fixture.host.querySelector<HTMLElement>('[data-testid="agent-chat-scroll"]')!;
  readAt(fixture.host, naturalPromptFlow(fixture.host).promptTop - 8);
  await expect.poll(() => pinnedPromptIds(fixture.host)).toEqual([]);
  await expectCurrentPromptGeometry(fixture.host);
  const text = row.querySelector<HTMLElement>('[data-testid="user-message-text"]')!;
  const node = exactTextNodes(row, prompt)[0]!;
  const bubble = row.querySelector<HTMLElement>('[data-testid="user-message-bubble"]')!;
  const clip = text.closest<HTMLElement>('[data-testid="text-preview-clip"]')!;
  const firstLine = document.createRange();
  firstLine.setStart(node, 0);
  firstLine.setEnd(node, prompt.indexOf("\n"));
  const ordinaryBubble = bubble.getBoundingClientRect();
  const ordinaryGlyphs = firstLine.getBoundingClientRect();
  const ordinaryPadding = getComputedStyle(bubble);
  const horizontalPadding =
    Number.parseFloat(ordinaryPadding.paddingLeft) +
    Number.parseFloat(ordinaryPadding.paddingRight);
  const ordinaryText = naturalPromptText(text, node);
  const ordinaryFlow = naturalPromptFlow(fixture.host);
  const bodyInset = ordinaryBubble.top - row.getBoundingClientRect().top;
  const glyphInset = ordinaryGlyphs.top - ordinaryBubble.top;
  const lineHeight = Number.parseFloat(getComputedStyle(text).lineHeight);
  expect(text.getBoundingClientRect().height).toBe(lineHeight * 3);
  const threshold = qualifiedPromptThreshold(fixture.host);
  expect(threshold).not.toBeNull();
  const tailOffset = threshold! - ordinaryFlow.promptTop;

  for (const offset of [6, 3, 1, -1, -3, -6, -12, -24, -12, -3, -1, 1, 3, 6]) {
    readAt(fixture.host, threshold! - offset);
    await expect
      .poll(() => row.getBoundingClientRect().top - scroll.getBoundingClientRect().top)
      .toBeCloseTo(offset - tailOffset, 0);
    await expect
      .poll(() => pinnedPromptIds(fixture.host))
      .toEqual(offset > 0 ? [] : [ACTUAL_PROMPT_ID]);
    await expectCurrentPromptGeometry(fixture.host);
    const bounds = bubble.getBoundingClientRect();
    const glyphs = firstLine.getBoundingClientRect();
    const disclosure = row.querySelector<HTMLElement>('[data-testid="user-message-disclosure"]');
    const controlBounds = disclosure?.getBoundingClientRect();
    const gap = controlBounds ? controlBounds.left - clip.getBoundingClientRect().right : 0;
    const fixedBubbleInkCapacity =
      ordinaryBubble.width - horizontalPadding - (controlBounds?.width ?? 0) - gap;
    const allocation = {
      ordinaryBubble: ordinaryBubble.toJSON(),
      currentBubble: bounds.toJSON(),
      firstLine: glyphs.toJSON(),
      originalFirstLine: ordinaryGlyphs.toJSON(),
      disclosure: controlBounds?.toJSON() ?? null,
      fixedBubbleInkCapacity,
      fullFirstLineFitsFixedBubble: ordinaryGlyphs.width <= fixedBubbleInkCapacity,
    };
    // Q24 keeps the exact natural horizontal frame. The real control may
    // obscure its right end, but never shifts or narrows the persistent Text.
    expect(bounds.x, JSON.stringify(allocation)).toBeCloseTo(ordinaryBubble.x, 0);
    expect(bounds.width).toBeCloseTo(ordinaryBubble.width, 0);
    expect(glyphs.left).toBeCloseTo(ordinaryGlyphs.left, 3);
    expect(glyphs.width).toBeCloseTo(ordinaryGlyphs.width, 3);
    expect(glyphs.height).toBeCloseTo(ordinaryGlyphs.height, 3);
    const expectedTop =
      offset > 0
        ? row.getBoundingClientRect().top + bodyInset
        : scroll.getBoundingClientRect().top + bodyInset;
    expect(bounds.top).toBeCloseTo(expectedTop, 0);
    expect(glyphs.top - bounds.top).toBeCloseTo(glyphInset, 3);
    expect(naturalPromptText(text, node)).toEqual(ordinaryText);
    expect(naturalPromptFlow(fixture.host)).toEqual(ordinaryFlow);
    expect(row.querySelector('[data-testid="user-message-text"]') === text).toBe(true);
    expect(exactTextNodes(fixture.host, prompt)).toHaveLength(1);
    if (offset > 0) {
      expect(bounds.height).toBeCloseTo(ordinaryBubble.height, 0);
      expectPreparedDisclosureHidden(row);
    } else {
      expect(disclosure).not.toBeNull();
      const control = disclosure!.getBoundingClientRect();
      expect(control.width).toBeGreaterThanOrEqual(44);
      expect(control.height).toBeGreaterThanOrEqual(44);
      expect(clip.getBoundingClientRect().height).toBeCloseTo(lineHeight, 0);
      let paddingCell = clip.parentElement;
      while (
        paddingCell &&
        paddingCell !== bubble &&
        Number.parseFloat(getComputedStyle(paddingCell).paddingTop) === 0
      ) {
        paddingCell = paddingCell.parentElement;
      }
      expect(paddingCell !== null && paddingCell !== bubble).toBe(true);
      const padding = getComputedStyle(paddingCell!);
      expect(bounds.height).toBeCloseTo(
        lineHeight +
          Number.parseFloat(padding.paddingTop) +
          Number.parseFloat(padding.paddingBottom),
        0,
      );
      expect(glyphs.left).toBeGreaterThanOrEqual(clip.getBoundingClientRect().left);
      expect(glyphs.right).toBeLessThanOrEqual(clip.getBoundingClientRect().right);
      expectOpaqueControlBacking(row, control);
    }
  }
});

it("omits compact attachment count while centering More within one pixel of the text clip", async () => {
  const canvas = document.createElement("canvas");
  canvas.width = 2;
  canvas.height = 2;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#356bd8";
  context.fillRect(0, 0, canvas.width, canvas.height);
  const image = await persistAttachmentFromDataUrl({
    dataUrl: canvas.toDataURL("image/png"),
    fileName: "centered-sample.png",
  });
  try {
    const prompt = "Attached sample.";
    const fixture = actualPrompt(prompt, {
      successorText: "Following attachment center control",
      images: [image],
      hostWidth: 390,
    });
    await document.fonts.ready;
    const row = fixture.host.querySelector<HTMLElement>(
      `[data-history-row-id="${ACTUAL_PROMPT_ID}"]`,
    )!;
    readAt(fixture.host, naturalPromptFlow(fixture.host).promptTop - 8);
    await expect.poll(() => pinnedPromptIds(fixture.host)).toEqual([]);
    await expect
      .poll(() =>
        Array.from(row.querySelectorAll("img")).some(
          (thumbnail) => thumbnail.complete && thumbnail.naturalWidth === 2,
        ),
      )
      .toBe(true);
    await expectCurrentPromptGeometry(fixture.host);
    const text = row.querySelector<HTMLElement>('[data-testid="user-message-text"]')!;
    const originalNode = exactTextNodes(row, prompt)[0]!;
    const originalFlow = naturalPromptFlow(fixture.host);
    const originalFrame = text.getBoundingClientRect();
    await readAtPromptHandoff(fixture.host);
    await expect.poll(() => pinnedPromptIds(fixture.host)).toEqual([ACTUAL_PROMPT_ID]);
    await expect
      .poll(() => row.querySelector('[data-testid="user-message-disclosure"]'))
      .not.toBeNull();
    await expectCurrentPromptGeometry(fixture.host);
    expect(row.querySelector('[data-testid="user-message-attachments-summary"]')).toBeNull();
    const clip = text.closest<HTMLElement>('[data-testid="text-preview-clip"]')!;
    const more = row.querySelector<HTMLElement>('[data-testid="user-message-disclosure"]')!;
    const moreBounds = more.getBoundingClientRect();
    const clipBounds = clip.getBoundingClientRect();
    expect(moreBounds.width).toBeGreaterThan(0);
    expect(moreBounds.height).toBeGreaterThanOrEqual(44);
    expect(clipBounds.width).toBeGreaterThan(0);
    expect(
      Math.abs(moreBounds.top + moreBounds.height / 2 - clipBounds.top - clipBounds.height / 2),
    ).toBeLessThanOrEqual(1);
    expectOpaqueControlBacking(row, moreBounds);
    expect(text.getBoundingClientRect().x).toBeCloseTo(originalFrame.x, 3);
    expect(text.getBoundingClientRect().width).toBeCloseTo(originalFrame.width, 3);
    expect(text.getBoundingClientRect().height).toBeCloseTo(originalFrame.height, 3);
    expect(naturalPromptFlow(fixture.host)).toEqual(originalFlow);
    expect(row.querySelector('[data-testid="user-message-text"]') === text).toBe(true);
    expect(exactTextNodes(fixture.host, prompt)[0] === originalNode).toBe(true);
    expect(exactTextNodes(fixture.host, prompt)).toHaveLength(1);
  } finally {
    act(() => actualRoot?.unmount());
    actualRoot = null;
    await deleteAttachments([image]);
  }
});

it("reveals both deep Find occurrences through the real viewport after an original-row landing", async () => {
  const query = "deep-flow-needle";
  const prompt = `Actual find ownership\n${"padding content for inner scrolling\n".repeat(65)}${query} first\n${"more padding\n".repeat(65)}${query} second`;
  const fixture = actualPrompt(prompt, {
    successorText: "Following Find ownership control",
    hostWidth: 820,
  });
  await document.fonts.ready;
  const row = fixture.host.querySelector<HTMLElement>(
    `[data-history-row-id="${ACTUAL_PROMPT_ID}"]`,
  )!;
  const scroll = fixture.host.querySelector<HTMLElement>('[data-testid="agent-chat-scroll"]')!;
  await readAtPromptHandoff(fixture.host);
  await expect.poll(() => pinnedPromptIds(fixture.host)).toEqual([ACTUAL_PROMPT_ID]);
  await expect
    .poll(() => row.querySelector('[data-testid="user-message-disclosure"]'))
    .not.toBeNull();
  await expectCurrentPromptGeometry(fixture.host);
  const text = row.querySelector<HTMLElement>('[data-testid="user-message-text"]')!;
  const originalNode = exactTextNodes(row, prompt)[0]!;
  const body = row.querySelector<HTMLElement>('[data-testid="user-message-body-scroll"]')!;
  const find = createFindViewport({
    getBindings: () => ({
      viewportRef: fixture.ref,
      revealLoadedMessage: () => true,
      visibleMessageIds: new Set([ACTUAL_PROMPT_ID, ACTUAL_SUCCESSOR_ID]),
    }),
    getRoot: () => fixture.host,
    highlightName: "paseo-chat-find-test",
  });
  const abort = new AbortController();
  try {
    for (const occurrence of [0, 1]) {
      await expect(find.reveal(ACTUAL_PROMPT_ID, query, occurrence, abort.signal)).resolves.toEqual(
        { occurrence, count: 2 },
      );
      // The original-row reveal contract must be observed after the real outer
      // owner moves, not inferred from the expansion request's early acknowledgement.
      await expect.poll(() => pinnedPromptIds(fixture.host)).toEqual([]);
      await expect.poll(() => body.dataset.bodyExpanded).toBe("true");
      await expectCurrentPromptGeometry(fixture.host);
      await expect
        .poll(() => {
          const ranges = highlightedRanges();
          const range = ranges[0];
          if (ranges.length !== 1 || !range || !text.contains(range.startContainer)) return false;
          const prefix = document.createRange();
          prefix.selectNodeContents(text);
          prefix.setEnd(range.startContainer, range.startOffset);
          const expectedStart =
            occurrence === 0 ? prompt.indexOf(query) : prompt.lastIndexOf(query);
          if (prefix.toString().length !== expectedStart) return false;
          const target = range.getBoundingClientRect();
          const limits = [
            scroll,
            body,
            text.closest<HTMLElement>('[data-testid="text-preview-clip"]')!,
          ].map((element) => {
            const bounds = element.getBoundingClientRect();
            return {
              left: bounds.left + element.clientLeft,
              top: bounds.top + element.clientTop,
              right: bounds.left + element.clientLeft + element.clientWidth,
              bottom: bounds.top + element.clientTop + element.clientHeight,
            };
          });
          return (
            target.width > 0 &&
            target.height > 0 &&
            target.left >= Math.max(...limits.map((bounds) => bounds.left)) &&
            target.right <= Math.min(...limits.map((bounds) => bounds.right)) &&
            target.top >= Math.max(...limits.map((bounds) => bounds.top)) - 1 &&
            target.bottom <= Math.min(...limits.map((bounds) => bounds.bottom)) + 1
          );
        })
        .toBe(true);
      expect(highlightedText()).toEqual([query]);
      expect(row.querySelector('[data-testid="user-message-text"]') === text).toBe(true);
      expect(exactTextNodes(fixture.host, prompt)[0] === originalNode).toBe(true);
      expect(exactTextNodes(fixture.host, prompt)).toHaveLength(1);
      expect(
        fixture.host.querySelectorAll(`[data-history-row-id="${ACTUAL_PROMPT_ID}"]`),
      ).toHaveLength(1);
    }
  } finally {
    abort.abort();
    find.clear();
  }
});

it("retires Find ordinary ownership on clear, supersession, abort and an empty reveal with a reused caller signal", async () => {
  const query = "selected-lifetime-needle";
  const prompt = `Selected original\n${"natural content\n".repeat(60)}${query}`;
  const successor = `Successor original\n${"following content\n".repeat(30)}${query}`;
  const fixture = actualPrompt(prompt, { successorText: successor, hostWidth: 820 });
  await document.fonts.ready;
  const row = fixture.host.querySelector<HTMLElement>(
    `[data-history-row-id="${ACTUAL_PROMPT_ID}"]`,
  )!;
  const nextRow = fixture.host.querySelector<HTMLElement>(
    `[data-history-row-id="${ACTUAL_SUCCESSOR_ID}"]`,
  )!;
  const body = row.querySelector<HTMLElement>("[data-actual-prompt-content]")!;
  const nextBody = nextRow.querySelector<HTMLElement>("[data-actual-prompt-content]")!;
  const handle = fixture.ref.current!;
  const originalScroll = handle.scrollToMessage!;
  const originalExpand = handle.expandMessageForFind!;
  const operations: NonNullable<Capture["occurrence"]>[] = [];
  const selections: AbortSignal[] = [];
  handle.scrollToMessage = (id, occurrence, placement) => {
    if (occurrence) operations.push(occurrence);
    originalScroll(id, occurrence, placement);
  };
  handle.expandMessageForFind = (id, signal) => {
    selections.push(signal);
    originalExpand(id, signal);
  };
  const find = createFindViewport({
    getBindings: () => ({
      viewportRef: fixture.ref,
      revealLoadedMessage: () => true,
      visibleMessageIds: new Set([ACTUAL_PROMPT_ID, ACTUAL_SUCCESSOR_ID]),
    }),
    getRoot: () => fixture.host,
    highlightName: "paseo-chat-find-test",
  });
  const caller = new AbortController();
  try {
    await find.reveal(ACTUAL_PROMPT_ID, query, 0, caller.signal);
    const first = operations.at(-1)!;
    expect(first.signal).not.toBe(caller.signal);
    expect(first.signal.aborted).toBe(false);
    expect(caller.signal.aborted).toBe(false);
    await expect.poll(() => row.dataset.promptPinned).toBe("false");
    expect(body.style.position).not.toBe("sticky");
    find.clear();
    expect(first.signal.aborted).toBe(true);
    expect(first.targetTop()).toBeNull();
    expect(caller.signal.aborted).toBe(false);
    await readAtPromptHandoff(fixture.host);
    await expect.poll(() => pinnedPromptIds(fixture.host)).toEqual([ACTUAL_PROMPT_ID]);
    expect(body.style.position).toBe("sticky");
    await expect
      .poll(() =>
        row.querySelector('[data-testid="user-message-disclosure"]')?.getAttribute("aria-expanded"),
      )
      .toBe("false");

    await find.reveal(ACTUAL_PROMPT_ID, query, 0, caller.signal);
    const second = operations.at(-1)!;
    expect(second.signal).not.toBe(first.signal);
    expect(second.signal.aborted).toBe(false);
    expect(first.targetTop()).toBeNull();
    await find.reveal(ACTUAL_SUCCESSOR_ID, query, 0, caller.signal);
    const third = operations.at(-1)!;
    expect(second.signal.aborted).toBe(true);
    expect(second.targetTop()).toBeNull();
    expect(third.signal.aborted).toBe(false);
    expect(caller.signal.aborted).toBe(false);
    await expect.poll(() => nextRow.dataset.promptPinned).toBe("false");
    expect(nextBody.style.position).not.toBe("sticky");
    expect(body.style.position).toBe("sticky");
    caller.abort();
    expect(third.signal.aborted).toBe(true);
    expect(third.targetTop()).toBeNull();
    await expect.poll(() => nextBody.style.position).toBe("sticky");

    const emptyCaller = new AbortController();
    await expect(
      find.reveal(ACTUAL_PROMPT_ID, "missing selected occurrence", 0, emptyCaller.signal),
    ).resolves.toEqual({ occurrence: 0, count: 0 });
    expect(selections.at(-1)!.aborted).toBe(true);
    expect(emptyCaller.signal.aborted).toBe(false);
    await expect.poll(() => body.style.position).toBe("sticky");
  } finally {
    caller.abort();
    find.clear();
  }
});

it("keeps a narrow wrapped first line stationary beneath the real right-side More overlay", async () => {
  const prompt =
    "A naturally wrapped first line must retain all of its original horizontal geometry even where More covers the end.";
  const fixture = actualPrompt(prompt, {
    successorText: "Following narrow control",
    hostWidth: 180,
  });
  await document.fonts.ready;
  const row = fixture.host.querySelector<HTMLElement>(
    `[data-history-row-id="${ACTUAL_PROMPT_ID}"]`,
  )!;
  const scroll = fixture.host.querySelector<HTMLElement>('[data-testid="agent-chat-scroll"]')!;
  readAt(fixture.host, naturalPromptFlow(fixture.host).promptTop - 8);
  await expect.poll(() => pinnedPromptIds(fixture.host)).toEqual([]);
  await expectCurrentPromptGeometry(fixture.host);
  const text = row.querySelector<HTMLElement>('[data-testid="user-message-text"]')!;
  const node = exactTextNodes(row, prompt)[0]!;
  const bubble = row.querySelector<HTMLElement>('[data-testid="user-message-bubble"]')!;
  const naturalText = naturalPromptText(text, node);
  const naturalBubble = bubble.getBoundingClientRect();
  const naturalFrame = text.getBoundingClientRect();
  const flow = naturalPromptFlow(fixture.host);
  // Read the real row's content box, independently of the natural-height adapter.
  // Pinned paint padding must not change the width or wrapping of its actions.
  const actions = row.querySelector<HTMLElement>('[data-testid="user-message-trailing-row"]')!;
  const actionContent = () => {
    const bounds = actions.getBoundingClientRect();
    const style = getComputedStyle(actions);
    return {
      width:
        bounds.width - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight),
      height:
        bounds.height -
        Number.parseFloat(style.paddingTop) -
        Number.parseFloat(style.paddingBottom),
    };
  };
  const originalActions = actionContent();
  expect(originalActions.width).toBeGreaterThan(0);
  expect(originalActions.height).toBeGreaterThan(0);
  expect(naturalText.lines.length).toBeGreaterThan(1);
  await readAtPromptHandoff(fixture.host);
  await expect.poll(() => pinnedPromptIds(fixture.host)).toEqual([ACTUAL_PROMPT_ID]);
  await expectCurrentPromptGeometry(fixture.host);
  const more = row.querySelector<HTMLElement>('[data-testid="user-message-disclosure"]')!;
  const control = more.getBoundingClientRect();
  const scrollBounds = scroll.getBoundingClientRect();
  expect(control.width).toBeGreaterThanOrEqual(44);
  expect(control.height).toBeGreaterThanOrEqual(44);
  expect(control.left).toBeGreaterThanOrEqual(scrollBounds.left);
  expect(control.right).toBeLessThanOrEqual(scrollBounds.right);
  expectOpaqueControlBacking(row, control);
  expect(bubble.getBoundingClientRect().x).toBeCloseTo(naturalBubble.x, 3);
  expect(bubble.getBoundingClientRect().width).toBeCloseTo(naturalBubble.width, 3);
  expect(text.getBoundingClientRect().x).toBeCloseTo(naturalFrame.x, 3);
  expect(text.getBoundingClientRect().width).toBeCloseTo(naturalFrame.width, 3);
  expect(text.getBoundingClientRect().height).toBeCloseTo(naturalFrame.height, 3);
  expect(naturalPromptText(text, node)).toEqual(naturalText);
  expect(actionContent()).toEqual(originalActions);
  const actionStyle = getComputedStyle(actions);
  expect([
    actionStyle.paddingTop,
    actionStyle.paddingRight,
    actionStyle.paddingBottom,
    actionStyle.paddingLeft,
  ]).toEqual(["8px", "8px", "8px", "8px"]);
  const paintedActions = actions.getBoundingClientRect();
  expect(paintedActions.left).toBeGreaterThanOrEqual(scrollBounds.left);
  expect(paintedActions.right).toBeLessThanOrEqual(scrollBounds.right);
  expect(naturalPromptFlow(fixture.host)).toEqual(flow);
  expect(row.querySelector('[data-testid="user-message-text"]') === text).toBe(true);
  expect(exactTextNodes(row, prompt)).toHaveLength(1);
  await userEvent.click(more);
  await expect.poll(() => more.getAttribute("aria-expanded")).toBe("true");
  await userEvent.click(more);
  await expect.poll(() => more.getAttribute("aria-expanded")).toBe("false");
  expect(actionContent()).toEqual(originalActions);
  expect(naturalPromptFlow(fixture.host)).toEqual(flow);
  readAt(fixture.host, flow.promptTop - 8);
  await expect.poll(() => pinnedPromptIds(fixture.host)).toEqual([]);
  expect(naturalPromptText(text, node)).toEqual(naturalText);
});

it("keeps ordinary prompt actions hittable across the real hover gap and pinned outsets", async () => {
  const prompt = "Hover this real message\nCross its ordinary gap\nThen click its trailing arrow";
  const navigate = vi.fn();
  const fixture = actualPrompt(prompt, {
    successorText: "Following hover target",
    hostWidth: 820,
    holdActionsVisible: false,
    onNavigate: navigate,
  });
  await document.fonts.ready;
  await expectCurrentPromptGeometry(fixture.host);
  const flow = naturalPromptFlow(fixture.host);
  readAt(fixture.host, flow.promptTop - 8);
  await expect.poll(() => pinnedPromptIds(fixture.host)).toEqual([]);
  const row = fixture.host.querySelector<HTMLElement>(
    `[data-history-row-id="${ACTUAL_PROMPT_ID}"]`,
  )!;
  const scroll = fixture.host.querySelector<HTMLElement>('[data-testid="agent-chat-scroll"]')!;
  const bubble = row.querySelector<HTMLElement>('[data-testid="user-message-bubble"]')!;
  const text = row.querySelector<HTMLElement>('[data-testid="user-message-text"]')!;
  const node = exactTextNodes(row, prompt)[0]!;
  const naturalText = naturalPromptText(text, node);
  const actions = row.querySelector<HTMLElement>('[data-testid="user-message-trailing-row"]')!;
  const next = row.querySelector<HTMLElement>('[data-testid="user-message-next"]')!;
  await userEvent.hover(scroll, { position: { x: 4, y: scroll.clientHeight - 4 } });
  await expect.poll(() => getComputedStyle(actions).opacity).toBe("0");
  await userEvent.hover(bubble);
  await expect.poll(() => getComputedStyle(actions).opacity).toBe("1");

  const bubbleBounds = bubble.getBoundingClientRect();
  const actionBounds = actions.getBoundingClientRect();
  const nextBounds = next.getBoundingClientRect();
  const scrollBounds = scroll.getBoundingClientRect();
  const gap = {
    x: nextBounds.left + nextBounds.width / 2,
    y: (bubbleBounds.bottom + actionBounds.top) / 2,
  };
  expect(actionBounds.top).toBeGreaterThan(bubbleBounds.bottom);
  expect(gap.x).toBeGreaterThan(bubbleBounds.left);
  expect(gap.x).toBeLessThan(bubbleBounds.right);
  await userEvent.hover(scroll, {
    position: { x: gap.x - scrollBounds.left, y: gap.y - scrollBounds.top },
  });
  await expect.poll(() => getComputedStyle(actions).opacity).toBe("1");
  expect(row.contains(document.elementFromPoint(gap.x, gap.y))).toBe(true);
  await userEvent.hover(next);
  expect(getComputedStyle(actions).opacity).toBe("1");
  const hit = next.getBoundingClientRect();
  expect(
    next.contains(document.elementFromPoint(hit.left + hit.width / 2, hit.top + hit.height / 2)),
  ).toBe(true);
  await userEvent.click(next);
  expect(navigate).toHaveBeenCalledTimes(1);
  expect(navigate).toHaveBeenCalledWith(ACTUAL_PROMPT_ID, 1);
  expect(naturalPromptFlow(fixture.host)).toEqual(flow);
  expect(naturalPromptText(text, node)).toEqual(naturalText);

  await userEvent.hover(scroll, { position: { x: 4, y: scroll.clientHeight - 4 } });
  await expect.poll(() => getComputedStyle(actions).opacity).toBe("0");
  await readAtPromptHandoff(fixture.host);
  await expect.poll(() => pinnedPromptIds(fixture.host)).toEqual([ACTUAL_PROMPT_ID]);
  await userEvent.hover(bubble);
  await expect.poll(() => getComputedStyle(actions).opacity).toBe("1");
  await userEvent.hover(next);
  expect(getComputedStyle(actions).opacity).toBe("1");
  const pinnedHit = next.getBoundingClientRect();
  expect(
    next.contains(
      document.elementFromPoint(
        pinnedHit.left + pinnedHit.width / 2,
        pinnedHit.top + pinnedHit.height / 2,
      ),
    ),
  ).toBe(true);
  await userEvent.click(next);
  expect(navigate).toHaveBeenCalledTimes(2);
  expect(naturalPromptFlow(fixture.host)).toEqual(flow);
  expect(row.querySelector('[data-testid="user-message-text"]')).toBe(text);
  expect(exactTextNodes(row, prompt)).toEqual([node]);
});

it("keeps visible Less inside the actual expanded bubble without moving its natural text", async () => {
  const prompt = Array.from(
    { length: 80 },
    (_, index) => `Line ${index + 1}: retain this ordinary width and wrapping.`,
  ).join("\n");
  const fixture = actualPrompt(prompt, {
    successorText: "Following expanded prompt",
    hostWidth: 390,
  });
  await document.fonts.ready;
  await expectCurrentPromptGeometry(fixture.host);
  const flow = naturalPromptFlow(fixture.host);
  await readAtPromptHandoff(fixture.host);
  await expect.poll(() => pinnedPromptIds(fixture.host)).toEqual([ACTUAL_PROMPT_ID]);
  const row = fixture.host.querySelector<HTMLElement>(
    `[data-history-row-id="${ACTUAL_PROMPT_ID}"]`,
  )!;
  const text = row.querySelector<HTMLElement>('[data-testid="user-message-text"]')!;
  const node = exactTextNodes(row, prompt)[0]!;
  const naturalText = naturalPromptText(text, node);
  const horizontal = {
    x: text.getBoundingClientRect().x,
    width: text.getBoundingClientRect().width,
  };
  const control = row.querySelector<HTMLElement>('[data-testid="user-message-disclosure"]')!;
  await userEvent.click(control);
  await expect.poll(() => control.getAttribute("aria-expanded")).toBe("true");
  await expectCurrentPromptGeometry(fixture.host);
  const body = row.querySelector<HTMLElement>('[data-testid="user-message-body-scroll"]')!;
  const bubble = row.querySelector<HTMLElement>('[data-testid="user-message-bubble"]')!;
  const controlBounds = control.getBoundingClientRect();
  const bodyBounds = body.getBoundingClientRect();
  const bubbleBounds = bubble.getBoundingClientRect();
  expect(controlBounds.top).toBeGreaterThanOrEqual(bodyBounds.top);
  expect(controlBounds.bottom).toBeLessThanOrEqual(bodyBounds.bottom);
  expect(controlBounds.left).toBeGreaterThanOrEqual(bubbleBounds.left);
  expect(controlBounds.right).toBeLessThanOrEqual(bubbleBounds.right);
  expect(controlBounds.width).toBeGreaterThanOrEqual(44);
  expect(controlBounds.height).toBeGreaterThanOrEqual(44);
  const label = control.lastElementChild!;
  expect(label.textContent).toBe(i18n.t("stickyPrompt.less"));
  expect(getComputedStyle(label).color).toBe(getComputedStyle(text).color);
  expect(getComputedStyle(control).opacity).toBe("1");
  const backing = control.parentElement!.querySelector<HTMLElement>(
    '[data-user-message-compact-occlusion="controls"]',
  )!;
  expect(backing).not.toBeNull();
  expect(getComputedStyle(backing).opacity).toBe("1");
  expect(getComputedStyle(backing).backgroundColor).toBe(getComputedStyle(bubble).backgroundColor);
  const labelBounds = label.getBoundingClientRect();
  expect(
    control.contains(
      document.elementFromPoint(
        labelBounds.left + labelBounds.width / 2,
        labelBounds.top + labelBounds.height / 2,
      ),
    ),
  ).toBe(true);
  expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
  expect({ x: text.getBoundingClientRect().x, width: text.getBoundingClientRect().width }).toEqual(
    horizontal,
  );
  expect(naturalPromptText(text, node)).toEqual(naturalText);
  expect(naturalPromptFlow(fixture.host)).toEqual(flow);
  await userEvent.click(control);
  await expect.poll(() => control.getAttribute("aria-expanded")).toBe("false");
  expect(naturalPromptFlow(fixture.host)).toEqual(flow);
  readAt(fixture.host, flow.promptTop - 8);
  await expect.poll(() => pinnedPromptIds(fixture.host)).toEqual([]);
  expect(row.querySelector('[data-testid="user-message-text"]')).toBe(text);
  expect(exactTextNodes(row, prompt)).toEqual([node]);
  expect(naturalPromptText(text, node)).toEqual(naturalText);
});

it.each(["normal", "virtual"] as const)(
  "stops local history fill after one PageUp reveals a full middle group in an underfilled %s viewport",
  async (placement) => {
    vi.stubGlobal("__PASEO_E2E_WEB_MOUNTED_RECENT_STREAM_ITEMS", 2);
    vi.stubGlobal(
      "__PASEO_E2E_WEB_PARTIAL_VIRTUALIZATION_THRESHOLD",
      placement === "virtual" ? 2 : 100,
    );
    const prompt = "Current ordinary prompt.";
    const items: import("@/types/stream").StreamItem[] = [
      {
        kind: "user_message",
        id: "oldest-user",
        text: "Oldest cached prompt.",
        timestamp: new Date(0),
      },
      {
        kind: "assistant_message",
        id: "oldest-answer",
        text: "Oldest cached answer",
        timestamp: new Date(1),
      },
      {
        kind: "user_message",
        id: "middle-user",
        text: "Middle ordinary prompt.",
        timestamp: new Date(2),
      },
      ...[1, 2, 3, 4].map((index): import("@/types/stream").StreamItem => ({
        kind: "assistant_message",
        id: `middle-answer-${index}`,
        text: `Middle answer ${index}`,
        timestamp: new Date(index + 2),
      })),
      { kind: "user_message", id: ACTUAL_PROMPT_ID, text: prompt, timestamp: new Date(7) },
      { kind: "assistant_message", id: "answer", text: "Current answer", timestamp: new Date(8) },
    ];
    let allowReveal = false;
    const acceptedReveal = vi.fn();
    const fixture = actualPrompt(prompt, {
      hostWidth: 390,
      hostHeight: 1600,
      disableOuterSpacing: false,
      localHistory: { items, allowReveal: () => allowReveal, onReveal: acceptedReveal },
    });
    await document.fonts.ready;
    const scroll = fixture.host.querySelector<HTMLElement>('[data-testid="agent-chat-scroll"]')!;
    const rows = fixture.host.querySelector<HTMLElement>("[data-stream-rows-host]")!;
    const answer = rows.querySelector<HTMLElement>('[data-history-row-id="answer"]')!;
    const row = rows.querySelector<HTMLElement>(`[data-history-row-id="${ACTUAL_PROMPT_ID}"]`)!;
    const body = row.querySelector<HTMLElement>("[data-actual-prompt-content]")!;
    const answerText = answer.querySelector<HTMLElement>(
      '[data-testid="assistant-surrounding-text"]',
    )!;
    const answerNode = answerText.firstChild;
    const promptNode = exactTextNodes(row, prompt)[0];
    await expect.poll(() => Number(body.dataset.promptFlowHeight)).toBeGreaterThan(0);
    await expect.poll(() => scroll.scrollHeight).toBe(scroll.clientHeight);
    expect(scroll.scrollTop).toBe(0);
    expect(acceptedReveal).not.toHaveBeenCalled();
    expect(
      Array.from(
        rows.querySelectorAll<HTMLElement>("[data-history-row-id]"),
        (element) => element.dataset.historyRowId,
      ),
    ).toEqual([ACTUAL_PROMPT_ID, "answer"]);
    const before = {
      answerTop: answer.getBoundingClientRect().top - scroll.getBoundingClientRect().top,
      scrollHeight: scroll.scrollHeight,
      clientHeight: scroll.clientHeight,
      flowHeight: Number(body.dataset.promptFlowHeight),
      text: answerText.textContent,
    };
    expect(before.answerTop).toBeGreaterThanOrEqual(0);
    expect(before.answerTop).toBeLessThan(before.clientHeight);
    // Mount-time fill was denied above. This actual input admits the real local
    // hook synchronously; no readAt, scroll write or default prevention primes it.
    scroll.focus();
    expect(document.activeElement).toBe(scroll);
    allowReveal = true;
    await userEvent.keyboard("{PageUp}");
    await expect.poll(() => acceptedReveal.mock.calls.length).toBe(1);

    // PageUp may intentionally scroll the newly filled range. Test finite fill,
    // not an impossible fixed answer position across the initial underfill blank.
    await expect.poll(() => scroll.scrollTop).toBeGreaterThan(HISTORY_START_THRESHOLD_PX);
    await expect
      .poll(() => fixture.host.querySelector('[data-testid="load-older-history-spinner"]'))
      .toBeNull();
    expect(acceptedReveal).toHaveBeenCalledTimes(1);
    expect(scroll.scrollHeight).toBeGreaterThan(before.scrollHeight);
    expect(scroll.scrollHeight).toBeGreaterThan(before.clientHeight);
    expect(scroll.clientHeight).toBe(before.clientHeight);
    expect(rows.querySelector('[data-history-row-id="answer"]')).toBe(answer);
    expect(answerText.firstChild).toBe(answerNode);
    expect(answerText.textContent).toBe(before.text);
    expect(rows.querySelector(`[data-history-row-id="${ACTUAL_PROMPT_ID}"]`)).toBe(row);
    expect(exactTextNodes(row, prompt)).toEqual([promptNode]);
    expect(Number(body.dataset.promptFlowHeight)).toBe(before.flowHeight);
    // The real local window has revealed the middle USER group, not exhausted
    // the source: both oldest cached rows remain available and unrendered.
    const visibleIds = [
      "middle-user",
      ...[1, 2, 3, 4].map((index) => `middle-answer-${index}`),
      ACTUAL_PROMPT_ID,
      "answer",
    ];
    expect(
      Array.from(
        rows.querySelectorAll<HTMLElement>("[data-history-row-id]"),
        (element) => element.dataset.historyRowId,
      ),
    ).toEqual(visibleIds);
    for (const id of visibleIds)
      expect(rows.querySelectorAll(`[data-history-row-id="${id}"]`)).toHaveLength(1);
    for (const id of ["oldest-user", "oldest-answer"])
      expect(rows.querySelector(`[data-history-row-id="${id}"]`)).toBeNull();
    expect(fixture.host.querySelector('[data-testid="sticky-prompt-system-feedback"]')).toBeNull();
  },
);

it.each(["normal", "virtual"] as const)(
  "preserves the ordinary answer when cached retained USER precedes the local %s window",
  async (placement) => {
    vi.stubGlobal("__PASEO_E2E_WEB_MOUNTED_RECENT_STREAM_ITEMS", 2);
    vi.stubGlobal(
      "__PASEO_E2E_WEB_PARTIAL_VIRTUALIZATION_THRESHOLD",
      placement === "virtual" ? 2 : 100,
    );
    const prompt = "Cached retained prompt.";
    const retainedPrompt: Extract<import("@/types/stream").StreamItem, { kind: "user_message" }> = {
      kind: "user_message",
      id: ACTUAL_PROMPT_ID,
      text: prompt,
      timestamp: new Date(0),
      timelineCursor: { epoch: "local-epoch", seq: 1 },
    };
    const items: import("@/types/stream").StreamItem[] = [
      retainedPrompt,
      ...[1, 2, 3].map((index): import("@/types/stream").StreamItem => ({
        kind: "assistant_message",
        id: `cached-answer-${index}`,
        text: `Cached answer ${index}`,
        timestamp: new Date(index),
        timelineCursor: { epoch: "local-epoch", seq: index + 1 },
      })),
      {
        kind: "user_message",
        id: ACTUAL_SUCCESSOR_ID,
        text: "Current ordinary prompt.",
        timestamp: new Date(4),
        timelineCursor: { epoch: "local-epoch", seq: 5 },
      },
      {
        kind: "assistant_message",
        id: "answer",
        text: "Current answer",
        timestamp: new Date(5),
        timelineCursor: { epoch: "local-epoch", seq: 6 },
      },
    ];
    let allowReveal = false;
    const acceptedReveal = vi.fn();
    const readingPosition = vi.fn();
    const fixture = actualPrompt(prompt, {
      hostWidth: 390,
      disableOuterSpacing: false,
      onReadingPositionChange: readingPosition,
      localHistory: {
        items,
        contexts: [
          { sourceKey: "local-source", sourceStart: 5, sourceEnd: 6, prompt: retainedPrompt },
        ],
        allowReveal: () => allowReveal,
        onReveal: acceptedReveal,
      },
    });
    await document.fonts.ready;
    const scroll = fixture.host.querySelector<HTMLElement>('[data-testid="agent-chat-scroll"]')!;
    const rows = fixture.host.querySelector<HTMLElement>("[data-stream-rows-host]")!;
    const answer = rows.querySelector<HTMLElement>('[data-history-row-id="answer"]')!;
    const row = rows.querySelector<HTMLElement>(`[data-history-row-id="${ACTUAL_PROMPT_ID}"]`)!;
    const body = row.querySelector<HTMLElement>("[data-actual-prompt-content]")!;
    const answerText = answer.querySelector<HTMLElement>(
      '[data-testid="assistant-surrounding-text"]',
    )!;
    const answerNode = answerText.firstChild;
    const promptNode = exactTextNodes(row, prompt)[0];
    await expect.poll(() => Number(body.dataset.promptFlowHeight)).toBeGreaterThan(0);
    // Let the actual virtual lane publish committed sizes before holding the reader.
    await expect
      .poll(() =>
        Math.abs(
          rows.getBoundingClientRect().height -
            (answer.getBoundingClientRect().bottom - row.getBoundingClientRect().top),
        ),
      )
      .toBeLessThanOrEqual(1);
    expect(
      Array.from(
        rows.querySelectorAll<HTMLElement>("[data-history-row-id]"),
        (element) => element.dataset.historyRowId,
      ),
    ).toEqual([ACTUAL_PROMPT_ID, ACTUAL_SUCCESSOR_ID, "answer"]);
    readAt(fixture.host, 0);
    await expect.poll(() => scroll.scrollTop).toBe(0);
    expect(acceptedReveal).not.toHaveBeenCalled();
    const anchorTop = () => answer.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
    const before = {
      anchorTop: anchorTop(),
      scrollHeight: scroll.scrollHeight,
      scrollTop: scroll.scrollTop,
      clientHeight: scroll.clientHeight,
      flowHeight: Number(body.dataset.promptFlowHeight),
      text: answerText.textContent,
    };
    expect(before.anchorTop).toBeGreaterThanOrEqual(0);
    expect(before.anchorTop).toBeLessThan(before.clientHeight);
    // Unlike the independent zero-delta case, readAt above already captured a reader.
    // The only uncovered boundary is the real model's retained-only local projection.
    allowReveal = true;
    // Admit the reveal at the same committed reading position. Dedicated PageUp
    // cases cover the browser's deliberate default scrolling separately.
    readAt(fixture.host, 0);
    await expect.poll(() => acceptedReveal.mock.calls.length).toBe(1);

    await expect.poll(() => Math.abs(anchorTop() - before.anchorTop)).toBeLessThanOrEqual(1);
    const growth = scroll.scrollHeight - before.scrollHeight;
    expect(growth).toBeGreaterThan(before.clientHeight);
    expect(Math.abs(scroll.scrollTop - before.scrollTop - growth)).toBeLessThanOrEqual(1);
    await expect
      .poll(() => fixture.host.querySelector('[data-testid="load-older-history-spinner"]'))
      .toBeNull();
    expect(acceptedReveal).toHaveBeenCalledTimes(1);
    expect(rows.querySelector('[data-history-row-id="answer"]')).toBe(answer);
    expect(answerText.firstChild).toBe(answerNode);
    expect(answerText.textContent).toBe(before.text);
    expect(rows.querySelector(`[data-history-row-id="${ACTUAL_PROMPT_ID}"]`)).toBe(row);
    expect(exactTextNodes(row, prompt)).toEqual([promptNode]);
    expect(Number(body.dataset.promptFlowHeight)).toBe(before.flowHeight);
    const ids = items.map((item) => item.id);
    expect(
      Array.from(
        rows.querySelectorAll<HTMLElement>("[data-history-row-id]"),
        (element) => element.dataset.historyRowId,
      ),
    ).toEqual(ids);
    for (const id of ids)
      expect(rows.querySelectorAll(`[data-history-row-id="${id}"]`)).toHaveLength(1);
    // Once its original local window is included, the genuine USER is eligible again.
    readAt(fixture.host, 0);
    await expect.poll(() => readingPosition.mock.lastCall?.[0]?.rowId).toBe(ACTUAL_PROMPT_ID);
    expect(acceptedReveal).toHaveBeenCalledTimes(1);
  },
);

it("yields ordinary sticky paint without releasing its full natural inline allocation", async () => {
  const prompt = "Existing ordinary body\n".repeat(24);
  const fixture = actualPrompt(prompt, { successorText: "Actual successor" });
  await document.fonts.ready;
  const scroll = fixture.host.querySelector<HTMLElement>('[data-testid="agent-chat-scroll"]')!;
  const content = scroll.firstElementChild as HTMLElement;
  const row = fixture.host.querySelector<HTMLElement>(
    `[data-history-row-id="${ACTUAL_PROMPT_ID}"]`,
  )!;
  const body = row.querySelector<HTMLElement>("[data-actual-prompt-content]")!;
  const text = row.querySelector<HTMLElement>('[data-testid="user-message-text"]')!;
  const node = exactTextNodes(row, prompt)[0]!;
  await readAtPromptHandoff(fixture.host);
  await expect.poll(() => pinnedPromptIds(fixture.host)).toEqual([ACTUAL_PROMPT_ID]);
  const before = naturalPromptFlow(fixture.host);
  const top = scroll.scrollTop;
  expect(before.flowHeight).toBeGreaterThan(scroll.clientHeight);
  // Exercise the real DOM paint owner before React expands the yielding body.
  // No dimensions or source/row geometry are fabricated for this transition.
  expect(syncActualPromptPin(content, scroll, true, [], 0, null, true)).toBeNull();
  expect(pinnedPromptIds(fixture.host)).toEqual([]);
  expect(body.getBoundingClientRect().top).toBeLessThan(scroll.getBoundingClientRect().top);
  expect(naturalPromptFlow(fixture.host)).toEqual(before);
  expect(scroll.scrollTop).toBe(top);
  expect(row.querySelector('[data-testid="user-message-text"]')).toBe(text);
  expect(exactTextNodes(row, prompt)).toEqual([node]);
  expect(syncActualPromptPin(content, scroll, true)).toBe(ACTUAL_PROMPT_ID);
  expect(pinnedPromptIds(fixture.host)).toEqual([ACTUAL_PROMPT_ID]);
  expect(naturalPromptFlow(fixture.host)).toEqual(before);
  expect(scroll.scrollTop).toBe(top);
});

function settleDisclosurePaint(): Promise<void> {
  return new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

/** Original ordinary allocation is independent of the sticky painted child. */
function disclosureOrdinaryGeometry(host: HTMLElement) {
  const scroll = host.querySelector<HTMLElement>('[data-testid="agent-chat-scroll"]')!;
  const row = host.querySelector<HTMLElement>(`[data-history-row-id="${ACTUAL_PROMPT_ID}"]`)!;
  const answer = host.querySelector<HTMLElement>('[data-history-row-id="answer"]')!;
  const body = row.querySelector<HTMLElement>("[data-actual-prompt-content]")!;
  const viewportTop = scroll.getBoundingClientRect().top;
  const bounds = row.getBoundingClientRect();
  const style = getComputedStyle(row);
  return {
    flowHeight: Number(body.dataset.promptFlowHeight),
    allocation:
      bounds.height + Number.parseFloat(style.marginTop) + Number.parseFloat(style.marginBottom),
    originalTop: bounds.top - viewportTop + scroll.scrollTop,
    answerTop: answer.getBoundingClientRect().top - viewportTop + scroll.scrollTop,
    scrollHeight: scroll.scrollHeight,
    scrollWidth: scroll.scrollWidth,
    scrollTop: scroll.scrollTop,
  };
}

it("keeps disclosure paint out of outer bottom-follow requests while real content growth still follows", async () => {
  const prompt = Array.from({ length: 48 }, (_, index) => `Original natural line ${index}.`).join(
    "\n",
  );
  // Default real fixture activation follows bottom; no readAt, wheel, explicit
  // navigation, or manual scroll write is allowed before the disclosure check.
  const fixture = actualPrompt(prompt);
  await document.fonts.ready;
  const scroll = fixture.host.querySelector<HTMLElement>('[data-testid="agent-chat-scroll"]')!;
  const row = fixture.host.querySelector<HTMLElement>(
    `[data-history-row-id="${ACTUAL_PROMPT_ID}"]`,
  )!;
  await expect.poll(() => pinnedPromptIds(fixture.host)).toEqual([ACTUAL_PROMPT_ID]);
  await expectCurrentPromptGeometry(fixture.host);
  const bodyViewport = row.querySelector<HTMLElement>('[data-testid="user-message-body-scroll"]')!;
  await expect.poll(() => bodyViewport.dataset.bodyExpanded).toBe("false");
  await expect
    .poll(() => Math.abs(scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop))
    .toBeLessThanOrEqual(1);
  await settleDisclosurePaint();
  const actualBody = row.querySelector<HTMLElement>('[data-testid="user-message"]')!;
  const text = row.querySelector<HTMLElement>('[data-testid="user-message-text"]')!;
  const node = exactTextNodes(row, prompt)[0]!;
  const before = disclosureOrdinaryGeometry(fixture.host);
  expect(before.flowHeight).toBeGreaterThan(scroll.clientHeight);
  expect(exactTextNodes(row, prompt)).toEqual([node]);
  // vi.spyOn calls the real HTMLElement method; no replacement implementation
  // can turn a requested outer scroll into a false green.
  const outerScroll = vi.spyOn(scroll, "scrollTo");
  const control = row.querySelector<HTMLElement>('[data-testid="user-message-disclosure"]')!;
  // Startup can still owe a no-op verification frame. Begin this observation
  // at the first real pointer input, before the disclosure handler runs.
  const beginDisclosureObservation = () => outerScroll.mockClear();
  control.addEventListener("pointerdown", beginDisclosureObservation, {
    capture: true,
    once: true,
  });
  try {
    await userEvent.click(control);
    await expect.poll(() => control.getAttribute("aria-expanded")).toBe("true");
    await expectCurrentPromptGeometry(fixture.host);
    await settleDisclosurePaint();
    expect(outerScroll).not.toHaveBeenCalled();
    expect(disclosureOrdinaryGeometry(fixture.host)).toEqual(before);
    expect(row.querySelector('[data-testid="user-message"]')).toBe(actualBody);
    expect(row.querySelector('[data-testid="user-message-text"]')).toBe(text);
    expect(exactTextNodes(row, prompt)).toEqual([node]);

    await userEvent.click(control);
    await expect.poll(() => control.getAttribute("aria-expanded")).toBe("false");
    await expectCurrentPromptGeometry(fixture.host);
    await settleDisclosurePaint();
    expect(outerScroll).not.toHaveBeenCalled();
    expect(disclosureOrdinaryGeometry(fixture.host)).toEqual(before);
    expect(row.querySelector('[data-testid="user-message"]')).toBe(actualBody);
    expect(row.querySelector('[data-testid="user-message-text"]')).toBe(text);
    expect(exactTextNodes(row, prompt)).toEqual([node]);

    const grown = `${prompt}\n${"Real appended natural content.\n".repeat(40)}`;
    fixture.render(true, grown);
    await expectCurrentPromptGeometry(fixture.host);
    await expect.poll(() => scroll.scrollHeight).toBeGreaterThan(before.scrollHeight);
    await expect
      .poll(() => Math.abs(scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop))
      .toBeLessThanOrEqual(1);
    await settleDisclosurePaint();
    const after = disclosureOrdinaryGeometry(fixture.host);
    expect(outerScroll).toHaveBeenCalled();
    expect(after.scrollTop).toBeGreaterThan(before.scrollTop);
    expect(after.flowHeight).toBeGreaterThan(before.flowHeight);
    expect(after.allocation).toBeGreaterThan(before.allocation);
    expect(
      Math.abs(after.answerTop - before.answerTop - (after.allocation - before.allocation)),
    ).toBeLessThanOrEqual(1);
    expect(row.querySelector('[data-testid="user-message"]')).toBe(actualBody);
    expect(row.querySelector('[data-testid="user-message-text"]')).toBe(text);
    expect(exactTextNodes(row, grown)).toHaveLength(1);
  } finally {
    control.removeEventListener("pointerdown", beginDisclosureObservation, true);
    outerScroll.mockRestore();
  }
});

it.each([false, true])(
  "keeps a very large actual USER stable through bottom handoff and disclosure (last USER only: %s)",
  async (lastUserOnly) => {
    const prompt = Array.from(
      { length: 1500 },
      (_, index) =>
        `Large paragraph ${index}: ${"preserve the actual inline message and its natural wrapping. ".repeat(3)}`,
    ).join("\n");
    const fixture = actualPrompt(prompt, { hostWidth: 390, hostHeight: 516, lastUserOnly });
    await document.fonts.ready;
    const scroll = fixture.host.querySelector<HTMLElement>('[data-testid="agent-chat-scroll"]')!;
    const row = fixture.host.querySelector<HTMLElement>(
      `[data-history-row-id="${ACTUAL_PROMPT_ID}"]`,
    )!;
    const text = row.querySelector<HTMLElement>('[data-testid="user-message-text"]')!;
    const textNode = text.firstChild;
    function readFlow() {
      const answer = fixture.host.querySelector<HTMLElement>('[data-history-row-id="answer"]');
      const rowBounds = row.getBoundingClientRect();
      const rowStyle = getComputedStyle(row);
      const allocation = Number(
        row.querySelector<HTMLElement>("[data-actual-prompt-content]")!.dataset.promptFlowHeight,
      );
      return {
        promptTop: rowBounds.top - scroll.getBoundingClientRect().top + scroll.scrollTop,
        flowHeight: answer ? answer.getBoundingClientRect().top - rowBounds.top : allocation,
        inlineAllocation:
          rowBounds.height +
          Number.parseFloat(rowStyle.marginTop) +
          Number.parseFloat(rowStyle.marginBottom),
        scrollHeight: scroll.scrollHeight,
        width: rowBounds.width,
        textHeight: text.getBoundingClientRect().height,
      };
    }
    readAt(fixture.host, 0);
    await expect.poll(() => pinnedPromptIds(fixture.host)).toEqual([]);
    const ordinary = readFlow();
    expect(ordinary.flowHeight).toBeGreaterThan(30_000);
    for (const offset of [-1, 0, 1, -1, 0, 1]) {
      readAt(fixture.host, ordinary.promptTop + offset);
      // The old top edge is still ordinary under the tail handoff policy.
      await expect.poll(() => pinnedPromptIds(fixture.host)).toEqual([]);
      await expect.poll(() => readFlow()).toEqual(ordinary);
    }
    readAt(fixture.host, scroll.scrollHeight - scroll.clientHeight);
    if (lastUserOnly) {
      await expect.poll(() => pinnedPromptIds(fixture.host)).toEqual([]);
      await expectCurrentPromptGeometry(fixture.host);
      const body = row.querySelector<HTMLElement>("[data-actual-prompt-content]")!;
      expect(readFlow()).toEqual(ordinary);
      expect(body.getBoundingClientRect().height).toBe(ordinary.inlineAllocation);
      const content = row.closest<HTMLElement>("[data-stream-rows-host]")!.parentElement!;
      expect(content.parentElement).toBe(scroll);
      const bottomPadding = Number.parseFloat(getComputedStyle(content).paddingBottom);
      expect(body.getBoundingClientRect().bottom + bottomPadding).toBe(
        scroll.getBoundingClientRect().bottom,
      );
      expectPreparedDisclosureHidden(row);
    } else {
      await expect.poll(() => pinnedPromptIds(fixture.host)).toEqual([ACTUAL_PROMPT_ID]);
      const bottom = scroll.scrollTop;
      await userEvent.click(
        row.querySelector<HTMLElement>('[data-testid="user-message-disclosure"]')!,
      );
      await expect
        .poll(() =>
          row
            .querySelector('[data-testid="user-message-body-scroll"]')
            ?.getAttribute("data-body-expanded"),
        )
        .toBe("true");
      expect(readFlow()).toEqual(ordinary);
      expect(scroll.scrollTop).toBe(bottom);
      await userEvent.click(
        row.querySelector<HTMLElement>('[data-testid="user-message-disclosure"]')!,
      );
      await expect
        .poll(() =>
          row
            .querySelector('[data-testid="user-message-body-scroll"]')
            ?.getAttribute("data-body-expanded"),
        )
        .toBe("false");
      expect(readFlow()).toEqual(ordinary);
      expect(scroll.scrollTop).toBe(bottom);
    }
    expect(row.querySelector('[data-testid="user-message-text"]')).toBe(text);
    expect(text.firstChild).toBe(textNode);
    expect(text.textContent).toBe(prompt);
  },
);

it("hands the actual body off when its natural tail reaches the fixed compact tail and reverses across More", async () => {
  const prompt = Array.from(
    { length: 32 },
    (_, index) =>
      `Natural original paragraph ${index}: ${"Keep the one live body at its original wrapping. ".repeat(3)}`,
  ).join("\n");
  // The existing real answer supplies enough ordinary scroll range for this
  // threshold. A sole last USER must not be padded merely to reach it.
  const fixture = actualPrompt(prompt, { hostWidth: 390, hostHeight: 516 });
  await document.fonts.ready;
  const scroll = fixture.host.querySelector<HTMLElement>('[data-testid="agent-chat-scroll"]')!;
  const row = fixture.host.querySelector<HTMLElement>(
    `[data-history-row-id="${ACTUAL_PROMPT_ID}"]`,
  )!;
  const body = row.querySelector<HTMLElement>("[data-actual-prompt-content]")!;
  const inner = row.querySelector<HTMLElement>('[data-testid="user-message-body-scroll"]')!;
  const text = row.querySelector<HTMLElement>('[data-testid="user-message-text"]')!;
  const node = exactTextNodes(row, prompt)[0]!;
  // Auto-following at the initial bottom reaches a valid compact state with
  // either policy. Read its actual qualified paint, never expanded More height.
  await expect.poll(() => pinnedPromptIds(fixture.host)).toEqual([ACTUAL_PROMPT_ID]);
  await expect.poll(() => inner.dataset.bodyExpanded).toBe("false");
  await expectCurrentPromptGeometry(fixture.host);
  const compactHeight = body.getBoundingClientRect().height;
  const initial = disclosureOrdinaryGeometry(fixture.host);
  const naturalText = naturalPromptText(text, node);
  const threshold = initial.originalTop + initial.allocation - compactHeight;
  expect(compactHeight).toBeGreaterThan(0);
  expect(initial.allocation).toBeGreaterThan(scroll.clientHeight);
  expect(compactHeight).toBeLessThan(scroll.clientHeight);
  expect(threshold + 1).toBeLessThanOrEqual(scroll.scrollHeight - scroll.clientHeight);

  function ordinaryAllocation() {
    const geometry = disclosureOrdinaryGeometry(fixture.host);
    const { scrollTop: _scrollTop, ...allocation } = geometry;
    return allocation;
  }
  const allocation = ordinaryAllocation();
  // First behavioral RED on current top-trigger source, before any new API.
  readAt(fixture.host, threshold - 1);
  await expect.poll(() => pinnedPromptIds(fixture.host)).toEqual([]);
  await expectCurrentPromptGeometry(fixture.host);
  expect(ordinaryAllocation()).toEqual(allocation);
  expect(body.getBoundingClientRect().height).toBe(initial.allocation);
  expect(body.getBoundingClientRect().top).toBe(row.getBoundingClientRect().top);
  expect(body.getBoundingClientRect().bottom - scroll.getBoundingClientRect().top).toBe(
    compactHeight + 1,
  );

  for (const offset of [0, 1, 0, -1]) {
    readAt(fixture.host, threshold + offset);
    await expect
      .poll(() => pinnedPromptIds(fixture.host))
      .toEqual(offset < 0 ? [] : [ACTUAL_PROMPT_ID]);
    await expectCurrentPromptGeometry(fixture.host);
    expect(ordinaryAllocation()).toEqual(allocation);
    if (offset < 0) {
      expect(body.getBoundingClientRect().height).toBe(initial.allocation);
      expect(body.getBoundingClientRect().top).toBe(row.getBoundingClientRect().top);
      expect(body.getBoundingClientRect().bottom - scroll.getBoundingClientRect().top).toBe(
        compactHeight + 1,
      );
    } else {
      expect(body.getBoundingClientRect().top).toBe(scroll.getBoundingClientRect().top);
      expect(body.getBoundingClientRect().height).toBe(compactHeight);
    }
    expect(row.querySelector('[data-testid="user-message-text"]')).toBe(text);
    expect(exactTextNodes(row, prompt)).toEqual([node]);
    expect(naturalPromptText(text, node)).toEqual(naturalText);
  }

  readAt(fixture.host, threshold + 1);
  await expect.poll(() => pinnedPromptIds(fixture.host)).toEqual([ACTUAL_PROMPT_ID]);
  const disclosure = row.querySelector<HTMLElement>('[data-testid="user-message-disclosure"]')!;
  const beforeMore = scroll.scrollTop;
  await userEvent.click(disclosure);
  await expect.poll(() => inner.dataset.bodyExpanded).toBe("true");
  await expectCurrentPromptGeometry(fixture.host);
  expect(body.getBoundingClientRect().height).toBeGreaterThan(compactHeight);
  expect(scroll.scrollTop).toBe(beforeMore);
  expect(ordinaryAllocation()).toEqual(allocation);
  // Expanded visual extent must not move the acquisition or reverse threshold.
  readAt(fixture.host, threshold - 1);
  await expect.poll(() => pinnedPromptIds(fixture.host)).toEqual([]);
  await expectCurrentPromptGeometry(fixture.host);
  expect(body.getBoundingClientRect().height).toBe(initial.allocation);
  expect(body.getBoundingClientRect().bottom - scroll.getBoundingClientRect().top).toBe(
    compactHeight + 1,
  );
  readAt(fixture.host, threshold);
  await expect.poll(() => pinnedPromptIds(fixture.host)).toEqual([ACTUAL_PROMPT_ID]);
  await expect.poll(() => inner.dataset.bodyExpanded).toBe("true");
  const beforeLess = scroll.scrollTop;
  await userEvent.click(row.querySelector<HTMLElement>('[data-testid="user-message-disclosure"]')!);
  await expect.poll(() => inner.dataset.bodyExpanded).toBe("false");
  await expectCurrentPromptGeometry(fixture.host);
  expect(scroll.scrollTop).toBe(beforeLess);
  expect(body.getBoundingClientRect().height).toBe(compactHeight);
  expect(ordinaryAllocation()).toEqual(allocation);
  expect(exactTextNodes(fixture.host, prompt)).toEqual([node]);
  expect(naturalPromptText(text, node)).toEqual(naturalText);
});

/** Hover may alter paint, never the committed ordinary transcript geometry. */
function hoverTranscriptGeometry(host: HTMLElement) {
  const scroll = host.querySelector<HTMLElement>('[data-testid="agent-chat-scroll"]')!;
  const row = host.querySelector<HTMLElement>(`[data-history-row-id="${ACTUAL_PROMPT_ID}"]`)!;
  const body = row.querySelector<HTMLElement>("[data-actual-prompt-content]")!;
  const text = row.querySelector<HTMLElement>('[data-testid="user-message-text"]')!;
  const inner = row.querySelector<HTMLElement>('[data-testid="user-message-body-scroll"]')!;
  const answer = host.querySelector<HTMLElement>('[data-history-row-id="answer"]')!;
  return {
    ...disclosureOrdinaryGeometry(host),
    clientHeight: scroll.clientHeight,
    clientWidth: scroll.clientWidth,
    compactHeight: Number(body.dataset.promptCompactHeight),
    visualHeight: Number(body.dataset.promptVisualHeight),
    bounded: body.dataset.promptBounded,
    bodyExpanded: inner.dataset.bodyExpanded,
    owners: pinnedPromptIds(host),
    body: body.getBoundingClientRect().toJSON(),
    text: text.getBoundingClientRect().toJSON(),
    answer: answer.getBoundingClientRect().toJSON(),
  };
}

/** Address visible points through the viewport so hovering a partially visible
 * assistant row cannot invoke the driver's scroll-into-view preparation.
 */
async function hoverVisibleTranscriptTarget(scroll: HTMLElement, target: HTMLElement) {
  const scrollBounds = scroll.getBoundingClientRect();
  const bounds = target.getBoundingClientRect();
  const left = Math.max(scrollBounds.left + 1, bounds.left + 1);
  const right = Math.min(scrollBounds.right - 1, bounds.right - 1);
  const top = Math.max(scrollBounds.top + 1, bounds.top + 1);
  const bottom = Math.min(scrollBounds.bottom - 1, bounds.bottom - 1);
  expect(right).toBeGreaterThan(left);
  expect(bottom).toBeGreaterThan(top);
  const x = (left + right) / 2;
  const y = (top + bottom) / 2;
  expect(target.contains(document.elementFromPoint(x, y))).toBe(true);
  await userEvent.hover(scroll, {
    position: { x: x - scrollBounds.left, y: y - scrollBounds.top },
  });
}

async function moveOutsideTranscript(host: HTMLElement) {
  const bounds = host.getBoundingClientRect();
  const body = document.body.getBoundingClientRect();
  const x = Math.min(window.innerWidth - 1, bounds.right + 2);
  expect(x).toBeGreaterThan(bounds.right);
  await userEvent.hover(document.body, {
    position: { x: x - body.left, y: bounds.top + 4 - body.top },
  });
}

it("keeps transcript geometry stationary after hovering actual prompt paint, actions and the ordinary answer", async () => {
  const prompt = "Hover this actual message\nCross its real actions\nThen stop over the answer";
  const fixture = actualPrompt(prompt, {
    hostWidth: 390,
    hostHeight: 516,
    holdActionsVisible: false,
  });
  await document.fonts.ready;
  const scroll = fixture.host.querySelector<HTMLElement>('[data-testid="agent-chat-scroll"]')!;
  const row = fixture.host.querySelector<HTMLElement>(
    `[data-history-row-id="${ACTUAL_PROMPT_ID}"]`,
  )!;
  const actualBody = row.querySelector<HTMLElement>('[data-testid="user-message"]')!;
  const bubble = row.querySelector<HTMLElement>('[data-testid="user-message-bubble"]')!;
  const actions = row.querySelector<HTMLElement>('[data-testid="user-message-trailing-row"]')!;
  const text = row.querySelector<HTMLElement>('[data-testid="user-message-text"]')!;
  const textNode = exactTextNodes(row, prompt)[0]!;
  const answer = fixture.host.querySelector<HTMLElement>('[data-history-row-id="answer"]')!;
  // First use actual mount-time bottom following. The second phase separately
  // prepares ordinary reading; neither phase scrolls during its hover observation.
  for (const pinned of [true, false]) {
    if (!pinned) {
      readAt(fixture.host, disclosureOrdinaryGeometry(fixture.host).originalTop - 8);
    }
    await expect
      .poll(() => pinnedPromptIds(fixture.host))
      .toEqual(pinned ? [ACTUAL_PROMPT_ID] : []);
    await expectCurrentPromptGeometry(fixture.host);
    await moveOutsideTranscript(fixture.host);
    // Let existing startup/scroll verification frames finish before recording
    // input. No startup call is treated as evidence that hover requested a scroll.
    for (let frame = 0; frame < 12; frame += 1) await settleDisclosurePaint();
    const before = hoverTranscriptGeometry(fixture.host);
    expect(before.compactHeight).toBeGreaterThan(0);
    expect(before.bounded).toBe(String(pinned));
    expect(before.bodyExpanded).toBe(String(!pinned));
    expect(exactTextNodes(row, prompt)).toEqual([textNode]);
    const outerScroll = vi.spyOn(scroll, "scrollTo");
    // Start once, at the first real pointer entry before the hover handlers.
    // Never clear after that input or during the stationary observation.
    const beginHoverObservation = () => outerScroll.mockClear();
    scroll.addEventListener("pointerover", beginHoverObservation, { capture: true, once: true });
    try {
      for (const target of [bubble, actions, answer, bubble, actions, answer]) {
        await hoverVisibleTranscriptTarget(scroll, target);
        if (target === bubble) await expect.poll(() => getComputedStyle(actions).opacity).toBe("1");
      }
      // The pointer now stays over the ordinary answer. Sample every frame,
      // rather than checking only an endpoint after autonomous motion could stop.
      for (let frame = 0; frame < 24; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const sample = hoverTranscriptGeometry(fixture.host);
        expect(
          sample,
          JSON.stringify({ pinned, frame, outerCalls: outerScroll.mock.calls, sample }),
        ).toEqual(before);
        expect(row.querySelector('[data-testid="user-message"]')).toBe(actualBody);
        expect(row.querySelector('[data-testid="user-message-text"]')).toBe(text);
        expect(exactTextNodes(row, prompt)).toEqual([textNode]);
      }
      await moveOutsideTranscript(fixture.host);
      for (let frame = 0; frame < 24; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const sample = hoverTranscriptGeometry(fixture.host);
        expect(
          sample,
          JSON.stringify({
            pinned,
            pointerOutside: true,
            frame,
            outerCalls: outerScroll.mock.calls,
            sample,
          }),
        ).toEqual(before);
      }
      expect(
        outerScroll,
        JSON.stringify({ pinned, outerCalls: outerScroll.mock.calls }),
      ).not.toHaveBeenCalled();
    } finally {
      scroll.removeEventListener("pointerover", beginHoverObservation, true);
      outerScroll.mockRestore();
    }
  }
});
