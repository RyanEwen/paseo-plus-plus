import { isWeb } from "@/constants/platform";
import { getOriginalPromptTop } from "../actual-prompt-pin.web";

/** Inner scrolling is part of this find occurrence, with its existing cancellation
 * and deadline. It never delegates an outer scroll to scrollIntoView.
 */
export function revealFindOccurrence(input: {
  range: Range;
  row: HTMLElement;
  signal: AbortSignal;
  deadline: number;
  clearance: number;
}): number | null {
  if (
    !isWeb ||
    input.signal.aborted ||
    performance.now() >= input.deadline ||
    !input.row.isConnected
  )
    return null;
  const parent = input.range.startContainer.parentElement;
  const body = parent?.closest<HTMLElement>('[data-testid="user-message-body-scroll"]');
  if (!body) {
    const localOffset = parent
      ? getOriginalPromptTop(parent) - parent.getBoundingClientRect().top
      : 0;
    return input.range.getBoundingClientRect().top + localOffset - input.clearance;
  }
  if (body.dataset.bodyExpanded === "false" || body.clientHeight <= 0) return null;
  const bounds = body.getBoundingClientRect();
  const target = input.range.getBoundingClientRect();
  let delta = 0;
  if (target.top < bounds.top) delta = target.top - bounds.top;
  else if (target.bottom > bounds.bottom) delta = target.bottom - bounds.bottom;
  if (delta !== 0) {
    const maximum = Math.max(0, body.scrollHeight - body.clientHeight);
    body.scrollTop = Math.max(0, Math.min(maximum, body.scrollTop + delta));
  }
  // The outer owner aligns the original row, not the selected range's translated
  // ink. Its body viewport now owns the selected range's local reveal.
  return getOriginalPromptTop(input.row) - input.clearance;
}
