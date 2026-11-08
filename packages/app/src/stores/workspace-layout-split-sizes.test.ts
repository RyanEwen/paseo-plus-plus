import { describe, expect, it } from "vitest";
import type { SplitNode, SplitPane, WorkspaceLayout } from "./workspace-layout-actions";
import {
  collectSplitSizes,
  convertSavedSplitSizes,
  projectMainSplitTree,
  withCurrentSplitSizes,
} from "./workspace-layout-split-sizes";

const EXPLORER = "explorer";

function pane(id: string): SplitNode {
  return { kind: "pane", pane: { id } as SplitPane };
}

function groupWithExplorer(): SplitNode {
  return {
    kind: "group",
    group: {
      id: "root",
      direction: "horizontal",
      children: [pane("a"), pane("b"), pane(EXPLORER)],
      sizes: [0.4, 0.4, 0.2],
    },
  };
}

function layoutOf(root: SplitNode): WorkspaceLayout {
  return { root, focusedPaneId: "a" } as WorkspaceLayout;
}

function groupSizes(node: SplitNode | null): number[] {
  if (node?.kind !== "group") {
    throw new Error("Expected a split group");
  }
  return node.group.sizes;
}

describe("split size overlay", () => {
  it("collects rendered children only, without the Explorer share", () => {
    expect(collectSplitSizes(groupWithExplorer(), EXPLORER)).toEqual({ root: [0.5, 0.5] });
  });

  it("keeps every child of a group without a docked Explorer", () => {
    expect(collectSplitSizes(groupWithExplorer(), null)).toEqual({ root: [0.4, 0.4, 0.2] });
  });

  it("converts an entry saved with the Explorer share on load", () => {
    const converted = convertSavedSplitSizes(
      { workspace: { root: [0.6, 0.2, 0.2] } },
      { workspace: layoutOf(groupWithExplorer()) },
      { workspace: EXPLORER },
    );
    expect(converted.workspace.root[0]).toBeCloseTo(0.75);
    expect(converted.workspace.root[1]).toBeCloseTo(0.25);
    expect(converted.workspace.root).toHaveLength(2);
  });

  it("leaves converted entries and unknown groups alone on later loads", () => {
    const saved = { workspace: { root: [0.75, 0.25], gone: [0.5, 0.5] } };
    const converted = convertSavedSplitSizes(
      saved,
      { workspace: layoutOf(groupWithExplorer()) },
      { workspace: EXPLORER },
    );
    expect(converted).toEqual(saved);
  });

  it("renders the saved rendered-children weights", () => {
    const projected = projectMainSplitTree(groupWithExplorer(), EXPLORER, { root: [0.75, 0.25] });
    expect(groupSizes(projected)).toEqual([0.75, 0.25]);
  });

  it("spreads saved weights around the Explorer's share before a structural edit", () => {
    const applied = withCurrentSplitSizes(
      layoutOf(groupWithExplorer()),
      { root: [0.75, 0.25] },
      EXPLORER,
    );
    const sizes = groupSizes(applied.root);
    expect(sizes[0]).toBeCloseTo(0.6);
    expect(sizes[1]).toBeCloseTo(0.2);
    expect(sizes[2]).toBeCloseTo(0.2);
  });
});
