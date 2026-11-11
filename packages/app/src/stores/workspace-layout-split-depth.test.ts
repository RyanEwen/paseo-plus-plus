import { describe, expect, it } from "vitest";
import {
  createDefaultLayout,
  getTreeDepth,
  splitPaneEmptyInLayout,
  type WorkspaceLayout,
} from "./workspace-layout-actions";
import { resolveBlockedSplitDirections } from "./workspace-layout-split-depth";

const UNLIMITED_DEPTH = 100;

/** A layout whose focused pane has just been split to the right, plus that pane's id. */
function layoutWithSideBySidePane(): { layout: WorkspaceLayout; paneId: string } {
  const start = createDefaultLayout();
  let nextId = 0;
  const result = splitPaneEmptyInLayout({
    layout: start,
    targetPaneId: start.focusedPaneId ?? "main",
    position: "right",
    maxTreeDepth: UNLIMITED_DEPTH,
    createNodeId: (prefix) => {
      nextId += 1;
      return `${prefix}-${nextId}`;
    },
  });
  if (!result) {
    throw new Error("Expected the fixture split to succeed");
  }
  return { layout: result.layout, paneId: result.paneId };
}

describe("resolveBlockedSplitDirections", () => {
  it("blocks only the direction that would add a nesting level at the limit", () => {
    const { layout, paneId } = layoutWithSideBySidePane();
    const blocked = resolveBlockedSplitDirections({
      layout,
      targetPaneId: paneId,
      maxTreeDepth: getTreeDepth(layout.root),
    });
    expect(blocked.has("horizontal")).toBe(false);
    expect(blocked.has("vertical")).toBe(true);
  });

  it("blocks nothing below the limit", () => {
    const { layout, paneId } = layoutWithSideBySidePane();
    const blocked = resolveBlockedSplitDirections({
      layout,
      targetPaneId: paneId,
      maxTreeDepth: UNLIMITED_DEPTH,
    });
    expect(blocked.size).toBe(0);
  });

  it("does not report a missing pane as a depth problem", () => {
    const { layout } = layoutWithSideBySidePane();
    const blocked = resolveBlockedSplitDirections({
      layout,
      targetPaneId: "missing",
      maxTreeDepth: 1,
    });
    expect(blocked.size).toBe(0);
  });
});
