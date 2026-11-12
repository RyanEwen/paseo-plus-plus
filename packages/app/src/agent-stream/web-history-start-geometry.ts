/**
 * Marks a Markdown block whose web parse has not been applied yet. The patched renderer sets it
 * while a message's text is still empty on screen; chat find waits on the same marker.
 */
const PENDING_MARKDOWN_SELECTOR = '[aria-busy="true"]';

/**
 * Whether any transcript row is still waiting for its first Markdown parse. Such a row renders
 * empty, so its height says nothing yet about whether the chat is short; history start waits
 * for the parse instead of deciding, and the resize that follows brings it back with real
 * heights. A streaming message re-parsing text it already shows does not count, so a live
 * chat never holds the decision.
 *
 * @param rowsHost - The element that holds every transcript row.
 */
export function hasPendingMarkdownRows(rowsHost: HTMLElement | null): boolean {
  if (!rowsHost) return false;
  return Array.from(rowsHost.querySelectorAll(PENDING_MARKDOWN_SELECTOR)).some(
    (block) => (block.textContent ?? "").trim().length === 0,
  );
}

/**
 * Whether the web transcript leaves the viewport short of content, so history start should
 * fill it with an older page without user input. Only meaningful once no row is still parsing
 * (see `hasPendingMarkdownRows`).
 *
 * @param input.rowsHost - The element that holds every transcript row.
 * @param input.auxiliary - The live auxiliary area below the rows, if mounted.
 * @param input.viewportHeight - The scroll container's client height, in pixels.
 */
export function isWebHistoryUnderfilled(input: {
  rowsHost: HTMLElement | null;
  auxiliary: HTMLElement | null;
  viewportHeight: number;
}): boolean {
  const rowsHeight = input.rowsHost?.getBoundingClientRect().height ?? 0;
  const auxiliaryHeight = input.auxiliary?.getBoundingClientRect().height ?? 0;
  return rowsHeight + auxiliaryHeight < input.viewportHeight;
}
