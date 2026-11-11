import React, { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { i18n } from "@/i18n/i18next";
import { ActualPromptTestFixture, ACTUAL_PROMPT_ID } from "./actual-prompt-rows.test-fixture";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { createFindViewport } from "./chat-find/viewport.web";
import type { ChatFindProps } from "./chat-find/types";
import type { StreamViewportHandle } from "./strategy";

export interface Capture {
  occurrence?: { signal: AbortSignal; targetTop(): number | null };
}

export function viewport(root: HTMLElement, capture: Capture) {
  const handle: StreamViewportHandle = {
    scrollToBottom() {},
    prepareForViewportChange() {},
    holdRow(_rowId, apply) {
      apply();
    },
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

let actualRoot: Root | null = null;

/** The root the current test rendered, unmounted by the shared afterEach. */
export function getActualRoot(): Root | null {
  return actualRoot;
}

export function setActualRoot(root: Root | null): void {
  actualRoot = root;
}

export function actualPrompt(
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
    | "enabled"
    | "wrapRow"
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
  render(fixtureOptions.enabled ?? true);
  return { host, ref, render };
}

export function exactTextNodes(root: HTMLElement, text: string): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode()))
    if (node instanceof Text && node.data === text) nodes.push(node);
  return nodes;
}

export function pinnedPromptIds(host: HTMLElement) {
  return Array.from(
    host.querySelectorAll<HTMLElement>('[data-actual-prompt-row][data-prompt-pinned="true"]'),
    (row) => row.dataset.historyRowId,
  );
}

/** Use the existing manual-reading admission before positioning the real outer
 * scroll owner. No layout values or renderer measurements are substituted.
 */
export function readAt(host: HTMLElement, top: number) {
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
export function qualifiedPromptThreshold(host: HTMLElement, id = ACTUAL_PROMPT_ID): number | null {
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

export async function readAtPromptHandoff(host: HTMLElement, id = ACTUAL_PROMPT_ID) {
  await expect.poll(() => qualifiedPromptThreshold(host, id)).not.toBeNull();
  const threshold = qualifiedPromptThreshold(host, id);
  if (threshold === null) throw new Error("The actual prompt has no qualified handoff geometry");
  readAt(host, threshold + 1);
}

/** Ordinary More remains prepared for measurement, unavailable to paint, input
 * and accessibility. Inert focus rejection proves more than DOM presence alone.
 */
export function expectPreparedDisclosureHidden(row: HTMLElement) {
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

/** Await the public flow/visual publication for the current real DOM layout.
 * Ownership alone can precede the measurement hook's layout publication. This
 * gate never requires the frame, glyph or attachment-center outcome under test.
 */
export async function expectCurrentPromptGeometry(host: HTMLElement) {
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

export function settleDisclosurePaint(): Promise<void> {
  return new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

export function ordinaryPreviewToggle(row: HTMLElement, label: "Show more" | "Show less") {
  return (
    Array.from(row.querySelectorAll<HTMLElement>('[role="button"]')).find(
      (button) => button.textContent === label,
    ) ?? null
  );
}

afterEach(() => {
  CSS.highlights.delete("paseo-chat-find-test");
  document.body.replaceChildren();
});

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  act(() => actualRoot?.unmount());
  actualRoot = null;
  vi.unstubAllGlobals();
});
