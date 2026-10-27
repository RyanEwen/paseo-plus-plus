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
import type { ChatFindProps } from "./types";
import type { StreamViewportHandle } from "../strategy";
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
    "successorText" | "images"
  > = {},
) {
  void i18n;
  const host = document.createElement("div");
  Object.assign(host.style, { width: "300px", height: "320px" });
  document.body.append(host);
  const ref = createRef<StreamViewportHandle>();
  actualRoot = createRoot(host);
  function render(enabled = true, nextText = text) {
    act(() =>
      actualRoot!.render(
        React.createElement(ActualPromptTestFixture, {
          ...options,
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

it("reveals a deep actual user match inside its body then its original row, and fences stale inner writes", async () => {
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
  await expect.poll(() => body.scrollHeight > body.clientHeight).toBe(true);
  await expect.poll(() => body.scrollTop > 0).toBe(true);
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
  const deepOffset = body.scrollTop;
  await userEvent.click(
    fixture.host.querySelector<HTMLElement>('[data-testid="user-message-disclosure"]')!,
  );
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
  await expect.poll(() => body.scrollTop < deepOffset).toBe(true);
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

  readAt(fixture.host, ordinaryFlow.promptTop + 24);
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

  readAt(fixture.host, ordinaryFlow.successorTop + 8);
  await expect.poll(() => pinnedPromptIds(fixture.host)).toEqual([ACTUAL_SUCCESSOR_ID]);
  await assertNaturalBody([ACTUAL_SUCCESSOR_ID]);
  readAt(fixture.host, ordinaryFlow.promptTop - 8);
  await expect.poll(() => pinnedPromptIds(fixture.host)).toEqual([]);
  await expect
    .poll(() => clip.getBoundingClientRect().height)
    .toBe(text.getBoundingClientRect().height);
  expect(disclosure()).toBeNull();
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
    readAt(fixture.host, ordinaryFlow.promptTop + 24);
    await expect.poll(() => pinnedPromptIds(fixture.host)).toEqual([ACTUAL_PROMPT_ID]);
    await expect.poll(() => disclosure()).not.toBeNull();
    await expect
      .poll(() => row.querySelector('[data-testid="user-message-attachments-summary"]'))
      .not.toBeNull();
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
    expect(glyphBounds.right).toBeLessThanOrEqual(disclosure().getBoundingClientRect().left);

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
