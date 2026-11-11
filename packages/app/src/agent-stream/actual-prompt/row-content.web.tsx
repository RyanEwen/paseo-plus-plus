import React, { type CSSProperties, createContext, useCallback, useContext, useMemo } from "react";
import type { NaturalMessageGeometry } from "@/components/prompt-message/flow-model";
import {
  ActualPinnedRowContext,
  ActualPromptFlowGeometryContext,
  ActualPromptRowsContext,
} from "../actual-prompt-rows";
import { getNaturalPromptRowHeight } from "../actual-prompt-pin.web";

/** The column layout of an ordinary stream row; matches strategy-web's row style. */
export const ACTUAL_ROW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "100%",
};

/**
 * A prompt row's content fills the row's reserved lane, so the message body's sticky
 * containing block spans it, while ordinary content after the message stays in flow.
 */
const ACTUAL_PROMPT_ROW_CONTENT_STYLE: CSSProperties = { ...ACTUAL_ROW_STYLE, flexGrow: 1 };

/** Registers the one element that sticks: the message body, rendered by ActualPromptBody. */
export const ActualPromptBodyContext = createContext<React.RefCallback<HTMLDivElement> | null>(
  null,
);

export interface MeasuredStreamRowGeometry {
  width: number;
  height: number;
  /** Last natural publication committed by the existing ordinary measurement owner. */
  promptFlowHeight?: string;
}

export interface RowGeometryChange {
  synchronous: boolean;
  natural: boolean;
}

/** The painted child's resize is not evidence that its ordinary allocation changed. */
export function hasNaturalRowChanges(
  entries: readonly ResizeObserverEntry[],
  content: HTMLElement,
  measurements: ReadonlyMap<string, MeasuredStreamRowGeometry>,
): boolean {
  const width = content.getBoundingClientRect().width;
  for (const entry of entries) {
    const row = entry.target.closest<HTMLElement>("[data-history-row-id]");
    // Departed cells and retained-only paint never enter the ordinary adapter.
    if (!row || !content.contains(row)) continue;
    const previous = measurements.get(row.dataset.historyRowId!);
    if (!previous || previous.width !== width) return true;
    if (row.matches("[data-actual-prompt-row]")) {
      const flow = row.querySelector<HTMLElement>("[data-actual-prompt-content]")?.dataset
        .promptFlowHeight;
      if (flow !== previous.promptFlowHeight) return true;
      // Before preparation the one body is ordinary layout. Once prepared, only
      // its natural publication owns height; the visual ResizeObserver may run
      // before that publication's matching paint size has been delivered.
      if (flow !== undefined) continue;
    }
    if (previous.height !== getNaturalPromptRowHeight(row)) return true;
  }
  return false;
}

interface ActualPromptFlowOwner {
  scope: string | undefined;
  node: HTMLDivElement | null;
  geometry: NaturalMessageGeometry | null;
}

/** Keep the natural reservation on the untransformed row, while CSS sticky sees
 * only this child's current paint extent. Ref departure retires the exact owner.
 */
export function ActualRowContent({
  pinned,
  isPrompt,
  bodyRef,
  onFlowGeometryChange,
  onPaintGeometryChange,
  children,
}: {
  pinned: boolean;
  isPrompt: boolean;
  bodyRef?: React.RefCallback<HTMLDivElement>;
  onFlowGeometryChange(): void;
  onPaintGeometryChange(): void;
  children: React.ReactNode;
}) {
  const scope = useContext(ActualPromptRowsContext)?.scope;
  const owner = useMemo<ActualPromptFlowOwner>(
    () => ({ scope, node: null, geometry: null }),
    [scope],
  );
  const applyGeometry = useCallback(() => {
    const node = owner.node;
    if (!node) return;
    const flow = owner.geometry ? String(owner.geometry.flowHeight) : undefined;
    const visual = owner.geometry ? String(owner.geometry.visualHeight) : undefined;
    const compact =
      owner.geometry?.compactHeight === undefined
        ? undefined
        : String(owner.geometry.compactHeight);
    const bounded =
      owner.geometry?.bounded === undefined ? undefined : String(owner.geometry.bounded);
    const naturalChanged = node.dataset.promptFlowHeight !== flow;
    if (
      !naturalChanged &&
      node.dataset.promptVisualHeight === visual &&
      node.dataset.promptCompactHeight === compact &&
      node.dataset.promptBounded === bounded
    )
      return;
    if (flow === undefined || visual === undefined) {
      delete node.dataset.promptFlowHeight;
      delete node.dataset.promptVisualHeight;
    } else {
      node.dataset.promptFlowHeight = flow;
      node.dataset.promptVisualHeight = visual;
    }
    if (compact === undefined) delete node.dataset.promptCompactHeight;
    else node.dataset.promptCompactHeight = compact;
    if (bounded === undefined) delete node.dataset.promptBounded;
    else node.dataset.promptBounded = bounded;
    if (naturalChanged) onFlowGeometryChange();
    else onPaintGeometryChange();
  }, [owner, onFlowGeometryChange, onPaintGeometryChange]);
  const reportGeometry = useCallback(
    (geometry: NaturalMessageGeometry | null) => {
      owner.geometry = geometry;
      applyGeometry();
    },
    [owner, applyGeometry],
  );
  const registerBody = useCallback(
    (node: HTMLDivElement | null) => {
      owner.node = node;
      if (!node) return;
      applyGeometry();
      const release = bodyRef?.(node);
      return () => {
        if (owner.node === node) owner.node = null;
        if (typeof release === "function") release();
        else bodyRef?.(null);
      };
    },
    [owner, bodyRef, applyGeometry],
  );
  const content = (
    <ActualPromptFlowGeometryContext.Provider value={isPrompt ? reportGeometry : null}>
      <ActualPinnedRowContext.Provider value={pinned}>{children}</ActualPinnedRowContext.Provider>
    </ActualPromptFlowGeometryContext.Provider>
  );
  if (!isPrompt) {
    return (
      <div ref={registerBody} data-actual-prompt-content style={ACTUAL_ROW_STYLE}>
        {content}
      </div>
    );
  }
  // Only the message body sticks. A collapsed turn's summary, rendered after the message
  // in the same row, stays ordinary content that scrolls away beneath the pinned prompt.
  return (
    <div data-actual-prompt-row-content style={ACTUAL_PROMPT_ROW_CONTENT_STYLE}>
      <ActualPromptBodyContext.Provider value={registerBody}>
        {content}
      </ActualPromptBodyContext.Provider>
    </div>
  );
}
