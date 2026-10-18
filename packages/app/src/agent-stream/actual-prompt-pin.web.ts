import { isWeb } from "@/constants/platform";
import { resolveActualPromptPin } from "./actual-prompt-pin-model";

/** The wrapper stays at the original position while its existing child sticks.
 * Local offsets inside that child remain valid for jumps, find and reading state.
 */
export function getOriginalPromptTop(element: HTMLElement): number {
  if (!isWeb) return 0;
  const body = element.closest<HTMLElement>("[data-actual-prompt-content]");
  const row = body?.closest<HTMLElement>("[data-actual-prompt-row]");
  if (!body || !row) return element.getBoundingClientRect().top;
  return (
    row.getBoundingClientRect().top +
    element.getBoundingClientRect().top -
    body.getBoundingClientRect().top
  );
}

export function getNaturalPromptRowHeight(row: HTMLElement): number {
  const body = row.matches("[data-actual-prompt-row]")
    ? row.querySelector<HTMLElement>("[data-actual-prompt-content]")
    : null;
  return (body ?? row).getBoundingClientRect().height;
}

/** Restore natural flow before any successor or reading-anchor measurement. A row
 * crossing from virtual to normal flow must not retain its old extended interval.
 */
export function reconcilePromptFlow(content: HTMLElement, enabled: boolean): void {
  if (!isWeb) return;
  for (const row of content.querySelectorAll<HTMLElement>("[data-actual-prompt-row]")) {
    const body = row.querySelector<HTMLElement>("[data-actual-prompt-content]");
    if (!body) continue;
    row.style.height = enabled ? `${body.getBoundingClientRect().height}px` : "";
    row.style.removeProperty("margin-bottom");
  }
}

export interface PromptLayoutPosition {
  id: string;
  top: number;
}

/** The lane supplies CSS's collision boundary; its negative margin preserves the
 * natural transcript flow. Virtual rows use layout top, never a transformed parent.
 * Scrolling only publishes ownership; the browser moves the real message body.
 */
export function syncActualPromptPin(
  content: HTMLElement,
  viewport: HTMLElement,
  enabled: boolean,
  virtualPrompts: readonly PromptLayoutPosition[] = [],
  virtualEnd = 0,
): string | null {
  if (!isWeb) return null;
  reconcilePromptFlow(content, enabled);
  const viewportTop = viewport.getBoundingClientRect().top;
  const rows = Array.from(content.querySelectorAll<HTMLElement>("[data-actual-prompt-row]"));
  const geometry = rows.map((row) => ({
    id: row.dataset.historyRowId!,
    top: row.getBoundingClientRect().top - viewportTop + viewport.scrollTop,
    height: getNaturalPromptRowHeight(row),
  }));
  const positions = new Map(virtualPrompts.map((row) => [row.id, row.top]));
  for (const row of geometry) positions.set(row.id, row.top);
  const ordered = Array.from(positions, ([id, top]) => ({ id, top })).sort((a, b) => a.top - b.top);
  const auxiliary = content.querySelector<HTMLElement>("[data-stream-auxiliary]");
  const auxiliaryEnd = auxiliary
    ? auxiliary.getBoundingClientRect().bottom - viewportTop + viewport.scrollTop
    : 0;
  const naturalEnd = Math.max(
    virtualEnd,
    auxiliaryEnd,
    ...Array.from(
      content.querySelectorAll<HTMLElement>("[data-history-row-id]"),
      (row) =>
        row.getBoundingClientRect().top -
        viewportTop +
        viewport.scrollTop +
        getNaturalPromptRowHeight(row),
    ),
  );
  const pin = enabled
    ? resolveActualPromptPin(
        ordered.map((row) => ({
          ...row,
          height: geometry.find((item) => item.id === row.id)?.height ?? 0,
        })),
        viewport.scrollTop,
      )
    : null;
  for (const row of rows) {
    const body = row.querySelector<HTMLElement>("[data-actual-prompt-content]");
    if (!body) continue;
    const own = geometry.find((item) => item.id === row.dataset.historyRowId)!;
    const index = ordered.findIndex((item) => item.id === own.id);
    const end = ordered[index + 1]?.top ?? naturalEnd;
    const height = Math.max(own.height, end - own.top);
    applyPromptLane(row, body, enabled, own.height, height, row.dataset.historyRowId === pin?.id);
  }
  return pin?.id ?? null;
}

function applyPromptLane(
  row: HTMLElement,
  body: HTMLElement,
  enabled: boolean,
  naturalHeight: number,
  height: number,
  pinned: boolean,
): void {
  row.style.height = enabled ? `${height}px` : "";
  if (enabled && !row.hasAttribute("data-index"))
    row.style.marginBottom = `${naturalHeight - height}px`;
  else row.style.removeProperty("margin-bottom");
  row.style.pointerEvents = enabled ? "none" : "";
  row.style.zIndex = enabled ? "2" : "";
  if (!row.hasAttribute("data-index")) row.style.position = enabled ? "relative" : "";
  body.style.position = enabled ? "sticky" : "";
  body.style.top = enabled ? "0px" : "";
  body.style.flexShrink = "0";
  body.style.pointerEvents = enabled ? "none" : "";
  body.style.transform = "";
  delete row.dataset.promptTranslation;
  row.dataset.promptPinned = pinned ? "true" : "false";
}
