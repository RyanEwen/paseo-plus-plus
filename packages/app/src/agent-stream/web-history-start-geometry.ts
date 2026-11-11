/**
 * Marks a Markdown block whose web parse has not been applied yet. The patched renderer sets it
 * while a message's text is still empty on screen; chat find waits on the same marker.
 */
const PENDING_MARKDOWN_SELECTOR = '[aria-busy="true"]';

/**
 * Whether the web transcript leaves the viewport short of content, so history start should
 * fill it with an older page without user input.
 *
 * A row whose Markdown is still parsing renders empty and would make a full chat look short
 * on a cold open. Treat that layout as not underfilled: the transcript reveals as usual, and the
 * resize that follows the parse re-evaluates the real height.
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
  if (input.rowsHost?.querySelector(PENDING_MARKDOWN_SELECTOR)) return false;
  const rowsHeight = input.rowsHost?.getBoundingClientRect().height ?? 0;
  const auxiliaryHeight = input.auxiliary?.getBoundingClientRect().height ?? 0;
  return rowsHeight + auxiliaryHeight < input.viewportHeight;
}
