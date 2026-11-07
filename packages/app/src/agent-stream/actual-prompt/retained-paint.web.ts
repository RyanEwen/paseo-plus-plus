import type { CSSProperties } from "react";
import type { StreamItem } from "@/types/stream";
import { ACTUAL_ROW_STYLE } from "./row-content.web";

export const RETAINED_PROMPT_ROW_STYLE: CSSProperties = {
  ...ACTUAL_ROW_STYLE,
  position: "absolute",
  left: 0,
  top: 0,
  height: 0,
  overflow: "hidden",
  visibility: "hidden",
  pointerEvents: "none",
  zIndex: 2,
};

export interface RetainedPromptPaintInput {
  content: HTMLElement;
  viewport: HTMLElement;
  prompt: StreamItem | undefined;
  ordinary: StreamItem[];
  virtualPrompts: readonly { id: string; top: number }[];
  enabled: boolean;
}

/** Place the one retained body at the paint edge, without claiming an original row top. */
export function positionRetainedPrompt({
  content,
  viewport,
  prompt,
  ordinary,
  virtualPrompts,
  enabled,
}: RetainedPromptPaintInput): string | null {
  const row = content.querySelector<HTMLElement>("[data-retained-prompt-row]");
  const host = content.querySelector<HTMLElement>("[data-stream-rows-host]");
  if (!row || !host) return null;
  row.style.visibility = "hidden";
  row.setAttribute("aria-hidden", "true");
  row.dataset.promptPinned = "false";
  if (!enabled || !prompt || row.dataset.retainedPromptRow !== prompt.id) return null;
  const viewportBounds = viewport.getBoundingClientRect();
  const nextIds = new Set(
    ordinary.flatMap((item) =>
      item.kind === "user_message" &&
      item.timelineCursor?.epoch === prompt.timelineCursor?.epoch &&
      item.timelineCursor !== undefined &&
      prompt.timelineCursor !== undefined &&
      item.timelineCursor.seq > prompt.timelineCursor.seq
        ? [item.id]
        : [],
    ),
  );
  let nextTop = Infinity;
  for (const candidate of virtualPrompts) {
    if (nextIds.has(candidate.id)) nextTop = Math.min(nextTop, candidate.top - viewport.scrollTop);
  }
  for (const candidate of content.querySelectorAll<HTMLElement>("[data-actual-prompt-row]")) {
    if (nextIds.has(candidate.dataset.historyRowId!))
      nextTop = Math.min(nextTop, candidate.getBoundingClientRect().top - viewportBounds.top);
  }
  if (nextTop <= 0) return null;
  const body = row.querySelector<HTMLElement>("[data-actual-prompt-content]");
  if (!body) return null;
  const collision = Math.min(0, nextTop - body.getBoundingClientRect().height);
  row.style.top = `${viewportBounds.top - host.getBoundingClientRect().top + collision}px`;
  // Clip all descendant overflow at the actual viewport end, including preparation.
  // This is a paint bound, never a synthetic inline allocation or virtual estimate.
  row.style.height = `${viewport.clientHeight}px`;
  row.style.visibility = "visible";
  row.setAttribute("aria-hidden", "false");
  row.dataset.promptPinned = "true";
  return prompt.id;
}

/** Retained-only paint changes are not transcript mutations for upstream bottom following. */
export function isRetainedPromptMutation(record: MutationRecord): boolean {
  const target = record.target instanceof Element ? record.target : record.target.parentElement;
  if (target?.closest("[data-retained-prompt-row]")) return true;
  const changed = [...record.addedNodes, ...record.removedNodes];
  return (
    changed.length > 0 &&
    changed.every((node) => node instanceof Element && node.matches("[data-retained-prompt-row]"))
  );
}

const promptPaintMutationSelector = [
  '[data-testid="user-message-disclosure"]',
  '[data-testid="user-message-content-target"]',
  '[data-testid="user-message-action-backdrop"]',
  '[data-testid="user-message-suffix-mask"]',
  "[data-user-message-compact-occlusion]",
  "[data-user-message-paint-backdrop]",
].join(",");

/** Only declared sticky paint is excluded; original body mutations still follow. */
export function isPromptPaintMutation(record: MutationRecord): boolean {
  if (isRetainedPromptMutation(record)) return true;
  const target = record.target instanceof Element ? record.target : record.target.parentElement;
  if (!target?.closest('[data-testid="user-message"]')) return false;
  if (target.closest(promptPaintMutationSelector)) return true;
  const changed = [...record.addedNodes, ...record.removedNodes];
  return (
    changed.length > 0 &&
    changed.every((node) => node instanceof Element && node.matches(promptPaintMutationSelector))
  );
}
