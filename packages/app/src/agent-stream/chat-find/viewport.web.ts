import { revealFindOccurrence } from "./body-reveal.web";
import type { ChatFindOperations } from "./model";
import type { ChatFindProps } from "./types";
import { findMessageMatches, findMessageRows, findRenderedMatches } from "./ranges.web";

interface ViewportInput {
  getBindings(): Pick<ChatFindProps, "viewportRef" | "revealLoadedMessage" | "visibleMessageIds">;
  getRoot(): HTMLElement | null;
  highlightName: string;
}

function rowOf(range: Range): HTMLElement | null {
  return range.startContainer.parentElement?.closest<HTMLElement>("[data-history-row-id]") ?? null;
}

/** Wait for the real ordinary body and physical sticky release before reading ranges. */
function areFindRowsReadyForReveal(rows: readonly HTMLElement[]): boolean {
  const body = rows[0]?.querySelector<HTMLElement>('[data-testid="user-message-body-scroll"]');
  const actualPrompt = body?.closest<HTMLElement>("[data-actual-prompt-content]");
  const awaitingOriginal = actualPrompt && rows.some((row) => row.dataset.promptPinned !== "false");
  if (
    body?.dataset.bodyExpanded === "false" ||
    awaitingOriginal ||
    actualPrompt?.style.position === "sticky"
  ) {
    return false;
  }
  return !rows.some((row) => row.querySelector('[aria-busy="true"]'));
}

export function createFindViewport({
  getBindings,
  getRoot,
  highlightName,
}: ViewportInput): Pick<ChatFindOperations, "reveal" | "clear"> {
  let generation = 0;
  let selection: AbortController | null = null;
  const releaseSelection = () => {
    selection?.abort();
    selection = null;
  };
  return {
    clear() {
      generation += 1;
      releaseSelection();
      CSS.highlights.delete(highlightName);
    },
    // The source message owns navigation; the rendered occurrence owns its position.
    reveal(messageId, query, occurrence, callerSignal) {
      const owner = ++generation;
      releaseSelection();
      // The selected generation outlives the acknowledgement while the outer
      // owner settles. Clear, supersession and caller cancellation retire it.
      const controller = new AbortController();
      selection = controller;
      const signal = controller.signal;
      const abort = () => controller.abort();
      callerSignal.addEventListener("abort", abort, { once: true });
      signal.addEventListener("abort", () => callerSignal.removeEventListener("abort", abort), {
        once: true,
      });
      if (callerSignal.aborted) abort();
      return new Promise((resolve, reject) => {
        let frame = 0;
        let started = false;
        let expansionRequested = false;
        const deadline = performance.now() + 5000;
        const cleanup = () => {
          cancelAnimationFrame(frame);
          signal.removeEventListener("abort", cancelled);
        };
        const fail = (error: unknown) => {
          cleanup();
          controller.abort();
          reject(error);
        };
        const cancelled = () => fail(new Error("Search cancelled"));
        const read = () => {
          if (signal.aborted || owner !== generation) {
            cancelled();
            return;
          }
          if (performance.now() >= deadline) {
            fail(new Error("Could not reveal this match; retry"));
            return;
          }
          const current = getBindings();
          if (!current.visibleMessageIds.has(messageId)) {
            current.revealLoadedMessage(messageId);
            frame = requestAnimationFrame(poll);
            return;
          }
          if (!expansionRequested && current.viewportRef.current) {
            current.viewportRef.current.expandMessageForFind?.(messageId, signal);
            expansionRequested = true;
          }
          const rows = findMessageRows(getRoot(), messageId);
          if (!rows.some((row) => row.getBoundingClientRect().height)) {
            if (!started) {
              current.viewportRef.current?.scrollToMessage?.(messageId);
              started = true;
            }
            frame = requestAnimationFrame(poll);
            return;
          }
          if (!areFindRowsReadyForReveal(rows)) {
            frame = requestAnimationFrame(poll);
            return;
          }
          const ranges = findMessageMatches(getRoot(), messageId, query);
          const index =
            occurrence < 0 ? ranges.length - 1 : Math.min(occurrence, ranges.length - 1);
          const range = ranges[index];
          cleanup();
          if (!range) {
            controller.abort();
            resolve({ occurrence: 0, count: 0 });
            return;
          }
          // The settle loop re-resolves the range every frame because scrolling
          // invalidates it. Re-counting the whole message would let a row mounting or
          // unmounting mid-scroll shift which occurrence a fixed index names, so the
          // occurrence is pinned to its own row for the rest of this reveal.
          const row = rowOf(range);
          const indexInRow = ranges
            .slice(0, index)
            .filter((earlier) => rowOf(earlier) === row).length;
          current.viewportRef.current?.scrollToMessage?.(messageId, {
            signal,
            targetTop() {
              if (signal.aborted || owner !== generation || performance.now() >= deadline)
                return null;
              const selected = row?.isConnected
                ? findRenderedMatches(row, query)[indexInRow]
                : undefined;
              if (!selected) return null;
              CSS.highlights.set(highlightName, new Highlight(selected));
              const widget = getRoot()?.querySelector<HTMLElement>(
                '[data-chat-find-widget="true"]',
              );
              const clearance = widget ? widget.getBoundingClientRect().height + 8 : 0;
              return row
                ? revealFindOccurrence({ range: selected, row, signal, deadline, clearance })
                : null;
            },
          });
          CSS.highlights.set(highlightName, new Highlight(range));
          resolve({ occurrence: index, count: ranges.length });
        };
        const poll = () => {
          try {
            read();
          } catch (error) {
            fail(error);
          }
        };
        signal.addEventListener("abort", cancelled, { once: true });
        frame = requestAnimationFrame(poll);
      });
    },
  };
}
