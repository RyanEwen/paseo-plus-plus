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
  const naturalHeight = Number(body?.dataset.promptFlowHeight);
  const visualHeight = Number(body?.dataset.promptVisualHeight);
  if (
    body &&
    naturalHeight > 0 &&
    visualHeight > 0 &&
    Number.isFinite(naturalHeight) &&
    Number.isFinite(visualHeight)
  ) {
    // The message renderer owns its inner extents. Keep the real row's remaining
    // group spacing and margins too, rather than reconstructing caller chrome.
    return naturalHeight + body.getBoundingClientRect().height - visualHeight;
  }
  return (body ?? row).getBoundingClientRect().height;
}

/** Add the real caller chrome to the body owner's independently prepared compact paint. */
function getCompactPromptRowHeight(row: HTMLElement): number | undefined {
  const body = row.querySelector<HTMLElement>("[data-actual-prompt-content]");
  const compact = Number(body?.dataset.promptCompactHeight);
  const visual = Number(body?.dataset.promptVisualHeight);
  if (
    !body ||
    !(compact > 0) ||
    !(visual > 0) ||
    !Number.isFinite(compact) ||
    !Number.isFinite(visual)
  )
    return undefined;
  return compact + body.getBoundingClientRect().height - visual;
}

/** Restore natural flow before any successor or reading-anchor measurement. A row
 * crossing from virtual to normal flow must not retain its old extended interval.
 */
export function reconcilePromptFlow(content: HTMLElement, enabled: boolean): void {
  if (!isWeb) return;
  for (const row of content.querySelectorAll<HTMLElement>("[data-actual-prompt-row]")) {
    const body = row.querySelector<HTMLElement>("[data-actual-prompt-content]");
    if (!body) continue;
    row.style.height = enabled ? `${getNaturalPromptRowHeight(row)}px` : "";
    row.style.removeProperty("margin-bottom");
  }
}

export interface PromptLayoutPosition {
  id: string;
  top: number;
}

export interface ActualPromptPinInput {
  content: HTMLElement;
  viewport: HTMLElement;
  enabled: boolean;
  /** Virtual prompt rows that are not mounted, with their layout tops. */
  virtualPrompts?: readonly PromptLayoutPosition[];
  /** The virtual content end, bounding the last prompt's lane. */
  virtualEnd?: number;
  /** A message Find is revealing at its original row, which must not pin. */
  originalMessageId?: string | null;
  /** Ordinary paint is owned elsewhere (retained prompt paint), so rows yield it. */
  yieldOrdinaryPaint?: boolean;
}

/** The lane supplies CSS's collision boundary; its negative margin preserves the
 * natural transcript flow. Virtual rows use layout top, never a transformed parent.
 * Scrolling only publishes ownership; the browser moves the real message body.
 */
export function syncActualPromptPin({
  content,
  viewport,
  enabled,
  virtualPrompts = [],
  virtualEnd = 0,
  originalMessageId = null,
  yieldOrdinaryPaint = false,
}: ActualPromptPinInput): string | null {
  if (!isWeb) return null;
  reconcilePromptFlow(content, enabled);
  const viewportTop = viewport.getBoundingClientRect().top;
  const rows = Array.from(content.querySelectorAll<HTMLElement>("[data-actual-prompt-row]"));
  // Preserve the natural lane and collision boundaries while this one selected
  // message yields physical sticky motion to Find's original-range reveal.
  const originalRows = new Set(
    rows
      .filter((row) => row.dataset.messageId === originalMessageId)
      .map((row) => row.dataset.historyRowId),
  );
  const geometry = rows.map((row) => ({
    id: row.dataset.historyRowId!,
    top: row.getBoundingClientRect().top - viewportTop + viewport.scrollTop,
    height: getNaturalPromptRowHeight(row),
    compactHeight: getCompactPromptRowHeight(row),
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
          compactHeight: geometry.find((item) => item.id === row.id)?.compactHeight,
        })),
        viewport.scrollTop,
      )
    : null;
  const prepared = pin && geometry.find((row) => row.id === pin.id)?.compactHeight !== undefined;
  const pinnedId =
    pin && prepared && !yieldOrdinaryPaint && !originalRows.has(pin.id) ? pin.id : null;
  for (const row of rows) {
    const body = row.querySelector<HTMLElement>("[data-actual-prompt-content]");
    if (!body) continue;
    const own = geometry.find((item) => item.id === row.dataset.historyRowId)!;
    const index = ordered.findIndex((item) => item.id === own.id);
    const end = ordered[index + 1]?.top ?? naturalEnd;
    const height = Math.max(own.height, end - own.top);
    applyPromptLane({
      row,
      body,
      enabled: enabled && !originalRows.has(own.id),
      naturalHeight: own.height,
      compactHeight: own.compactHeight,
      height,
      pinned: own.id === pinnedId,
      yieldPaint: yieldOrdinaryPaint,
    });
  }
  return pinnedId;
}

interface PromptLaneInput {
  row: HTMLElement;
  body: HTMLElement;
  enabled: boolean;
  naturalHeight: number;
  compactHeight: number | undefined;
  /** The lane height: the row's own natural height, or the gap to the next prompt. */
  height: number;
  pinned: boolean;
  /** An ordinary paint owner (such as Find) holds paint, so this row yields it. */
  yieldPaint: boolean;
}

function applyPromptLane({
  row,
  body,
  enabled,
  naturalHeight,
  compactHeight,
  height,
  pinned,
  yieldPaint,
}: PromptLaneInput): void {
  row.style.height = enabled ? `${height}px` : "";
  if (enabled && !row.hasAttribute("data-index"))
    row.style.marginBottom = `${naturalHeight - height}px`;
  else row.style.removeProperty("margin-bottom");
  row.style.pointerEvents = enabled ? "none" : "";
  row.style.zIndex = enabled ? "2" : "";
  if (!row.hasAttribute("data-index")) row.style.position = enabled ? "relative" : "";
  // A certified retained owner can release this body's sticky paint while its
  // existing full natural allocation remains installed through React's handoff.
  const sticky = enabled && !yieldPaint && compactHeight !== undefined;
  body.style.position = sticky ? "sticky" : "";
  // The full original keeps moving until its tail reaches compact paint's tail.
  // During the React handoff, an ordinary body must not jump to the top before
  // its bounded paint commits. More remains at the top without moving this gate.
  const bounded = pinned && body.dataset.promptBounded === "true";
  const ordinaryTop = Math.min(0, (compactHeight ?? naturalHeight) - naturalHeight);
  const stickyTop = bounded ? 0 : ordinaryTop;
  body.style.top = sticky ? `${stickyTop}px` : "";
  body.style.flexShrink = "0";
  body.style.pointerEvents = enabled ? "none" : "";
  body.style.transform = "";
  delete row.dataset.promptTranslation;
  row.dataset.promptPinned = pinned ? "true" : "false";
}
