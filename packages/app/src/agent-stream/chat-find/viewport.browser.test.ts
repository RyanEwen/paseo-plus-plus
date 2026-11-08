import React, { act } from "react";
import { userEvent } from "vitest/browser";
import { ACTUAL_PROMPT_ID, ACTUAL_SUCCESSOR_ID } from "../actual-prompt-rows.test-fixture";
import { expect, it, vi } from "vitest";
import { createFindViewport } from "./viewport.web";
import { ChatFindModel } from "./model";
import { SelectedMessage } from "./selection";
import { findMessageMatches } from "./ranges.web";
import {
  Capture,
  viewport,
  actualPrompt,
  exactTextNodes,
  pinnedPromptIds,
  readAtPromptHandoff,
  expectPreparedDisclosureHidden,
  expectCurrentPromptGeometry,
  ordinaryPreviewToggle,
} from "../actual-prompt-browser.test-fixture";

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

/** Subscribe to the real Find model's canonical selection, as the production ChatFind does. */
function PreviewFindSelection({
  model,
  children,
}: React.PropsWithChildren<{ model: ChatFindModel }>) {
  const state = React.useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  return React.createElement(SelectedMessage.Provider, { value: state.selectedItemId }, children);
}

async function expectOrdinaryFindRangeVisible(host: HTMLElement, text: HTMLElement, query: string) {
  await expect
    .poll(() => {
      const ranges = highlightedRanges();
      const range = ranges[0];
      if (ranges.length !== 1 || !range || !text.contains(range.startContainer)) return false;
      const scroll = host.querySelector<HTMLElement>('[data-testid="agent-chat-scroll"]')!;
      const preview = text.closest<HTMLElement>('[data-testid="user-message-preview-clip"]')!;
      const target = range.getBoundingClientRect();
      const viewportBounds = scroll.getBoundingClientRect();
      const previewBounds = preview.getBoundingClientRect();
      return (
        range.toString() === query &&
        target.width > 0 &&
        target.height > 0 &&
        preview.dataset.messagePreviewExpanded === "true" &&
        target.top >= Math.max(viewportBounds.top, previewBounds.top) - 1 &&
        target.bottom <= Math.min(viewportBounds.bottom, previewBounds.bottom) + 1 &&
        target.left >= Math.max(viewportBounds.left, previewBounds.left) - 1 &&
        target.right <= Math.min(viewportBounds.right, previewBounds.right) + 1
      );
    })
    .toBe(true);
}

it("reveals deep OFF preview Find ranges and releases temporary expansion without changing manual disclosure", async () => {
  const query = "ordinary-preview-find-needle";
  const replacement = "replacement-preview-find-needle";
  const prompt = `Original preview\n${"Full unbounded text for original selection.\n".repeat(48)}${query}\n${replacement}`;
  const successor = `Second preview\n${"Full unbounded text for successor selection.\n".repeat(36)}${query}`;
  let fixture: ReturnType<typeof actualPrompt>;
  const operations: NonNullable<Capture["occurrence"]>[] = [];
  const load = vi.fn(async () => undefined);
  const find = createFindViewport({
    getBindings: () => ({
      viewportRef: fixture.ref,
      revealLoadedMessage: () => true,
      visibleMessageIds: new Set([ACTUAL_PROMPT_ID, ACTUAL_SUCCESSOR_ID]),
    }),
    getRoot: () => fixture.host,
    highlightName: "paseo-chat-find-test",
  });
  const model = new ChatFindModel({
    async search(requested) {
      return {
        requestId: "preview-find-search",
        agentId: "agent",
        epoch: "preview-epoch",
        locations:
          requested === query
            ? [
                { seq: 1, role: "user" as const, count: 1 },
                { seq: 2, role: "user" as const, count: 1 },
              ]
            : [{ seq: 1, role: "user" as const, count: 1 }],
        nextCursor: null,
        error: null,
      };
    },
    load,
    ...find,
  });
  const wrapRow = (content: React.ReactNode) =>
    React.createElement(PreviewFindSelection, { model }, content);
  fixture = actualPrompt(prompt, {
    enabled: false,
    successorText: successor,
    hostWidth: 390,
    wrapRow,
  });
  model.updateHistory("preview-epoch", [
    {
      id: ACTUAL_PROMPT_ID,
      messageId: "provider-original",
      kind: "user_message",
      text: prompt,
      timestamp: new Date(0),
      timelineCursor: { epoch: "preview-epoch", seq: 1 },
    },
    {
      id: ACTUAL_SUCCESSOR_ID,
      messageId: "provider-successor",
      kind: "user_message",
      text: successor,
      timestamp: new Date(1),
      timelineCursor: { epoch: "preview-epoch", seq: 2 },
    },
  ]);
  await document.fonts.ready;
  const row = fixture.host.querySelector<HTMLElement>(
    `[data-history-row-id="${ACTUAL_PROMPT_ID}"]`,
  )!;
  const nextRow = fixture.host.querySelector<HTMLElement>(
    `[data-history-row-id="${ACTUAL_SUCCESSOR_ID}"]`,
  )!;
  await expect.poll(() => ordinaryPreviewToggle(row, "Show more")).not.toBeNull();
  await expect.poll(() => ordinaryPreviewToggle(nextRow, "Show more")).not.toBeNull();
  const text = row.querySelector<HTMLElement>('[data-testid="user-message-text"]')!;
  const nextText = nextRow.querySelector<HTMLElement>('[data-testid="user-message-text"]')!;
  const node = exactTextNodes(row, prompt)[0]!;
  const nextNode = exactTextNodes(nextRow, successor)[0]!;
  const preview = row.querySelector<HTMLElement>('[data-testid="user-message-preview-clip"]')!;
  const nextPreview = nextRow.querySelector<HTMLElement>(
    '[data-testid="user-message-preview-clip"]',
  )!;
  expect(preview.getBoundingClientRect().height).toBe(240);
  expect(
    findMessageMatches(fixture.host, ACTUAL_PROMPT_ID, query)[0]!.getBoundingClientRect().top,
  ).toBeGreaterThan(preview.getBoundingClientRect().bottom);
  const handle = fixture.ref.current!;
  const originalScroll = handle.scrollToMessage!;
  handle.scrollToMessage = (id, occurrence, placement) => {
    if (occurrence) operations.push(occurrence);
    originalScroll(id, occurrence, placement);
  };
  try {
    act(() => {
      model.open();
      model.setQuery(query);
    });
    await expect.poll(() => model.getSnapshot().phase).toBe("ready");
    expect(model.getSnapshot().selectedItemId).toBe(ACTUAL_PROMPT_ID);
    await expectOrdinaryFindRangeVisible(fixture.host, text, query);
    const first = operations.at(-1)!;
    act(() => model.next());
    await expect.poll(() => model.getSnapshot().selectedItemId).toBe(ACTUAL_SUCCESSOR_ID);
    await expect.poll(() => model.getSnapshot().phase).toBe("ready");
    await expectOrdinaryFindRangeVisible(fixture.host, nextText, query);
    expect(first.signal.aborted).toBe(true);
    expect(first.targetTop()).toBeNull();
    await expect.poll(() => preview.getBoundingClientRect().height).toBe(240);
    await expect.poll(() => ordinaryPreviewToggle(row, "Show more")).not.toBeNull();
    await userEvent.click(ordinaryPreviewToggle(row, "Show more")!);
    await expect.poll(() => ordinaryPreviewToggle(row, "Show less")).not.toBeNull();
    const selectedSuccessor = operations.at(-1)!;
    act(() => model.setQuery(replacement));
    await expect.poll(() => model.getSnapshot().phase).toBe("ready");
    expect(model.getSnapshot().selectedItemId).toBe(ACTUAL_PROMPT_ID);
    await expectOrdinaryFindRangeVisible(fixture.host, text, replacement);
    expect(selectedSuccessor.signal.aborted).toBe(true);
    expect(selectedSuccessor.targetTop()).toBeNull();
    const current = operations.at(-1)!;
    act(() => model.setQuery(""));
    expect(current.signal.aborted).toBe(true);
    expect(current.targetTop()).toBeNull();
    expect(model.getSnapshot().selectedItemId).toBeNull();
    await expect.poll(() => ordinaryPreviewToggle(row, "Show less")).not.toBeNull();
    await expect.poll(() => ordinaryPreviewToggle(nextRow, "Show more")).not.toBeNull();
    act(() => model.setQuery(query));
    await expect.poll(() => model.getSnapshot().phase).toBe("ready");
    await expectOrdinaryFindRangeVisible(fixture.host, text, query);
    const reopened = operations.at(-1)!;
    act(() => model.close());
    expect(reopened.signal.aborted).toBe(true);
    expect(reopened.targetTop()).toBeNull();
    await expect.poll(() => ordinaryPreviewToggle(row, "Show less")).not.toBeNull();
    await expect.poll(() => ordinaryPreviewToggle(nextRow, "Show more")).not.toBeNull();
    expect(preview.dataset.messagePreviewExpanded).toBe("true");
    expect(nextPreview.dataset.messagePreviewExpanded).toBe("false");
    expect(nextPreview.getBoundingClientRect().height).toBe(240);
    await userEvent.click(ordinaryPreviewToggle(row, "Show less")!);
    await expect.poll(() => preview.getBoundingClientRect().height).toBe(240);
    expect(exactTextNodes(fixture.host, prompt)).toEqual([node]);
    expect(exactTextNodes(fixture.host, successor)).toEqual([nextNode]);
    expect(row.querySelector('[data-testid="user-message-text"]')).toBe(text);
    expect(nextRow.querySelector('[data-testid="user-message-text"]')).toBe(nextText);
    expect(
      fixture.host.querySelectorAll(`[data-history-row-id="${ACTUAL_PROMPT_ID}"]`),
    ).toHaveLength(1);
    expect(
      fixture.host.querySelectorAll(`[data-history-row-id="${ACTUAL_SUCCESSOR_ID}"]`),
    ).toHaveLength(1);
    expect(load).not.toHaveBeenCalled();
  } finally {
    act(() => model.close());
  }
});
