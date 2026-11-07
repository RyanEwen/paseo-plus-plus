import {
  clampNormalizedSizes,
  type SplitGroup,
  type SplitNode,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-actions";

/**
 * Committed divider weights per split group, keyed by group id (`splitSizesByWorkspace[workspace]`).
 *
 * An entry has one of two lengths. Structural edits (split, move) save every child of the
 * group, including a docked Explorer pane. Ordinary divider drags and presets commit the rendered
 * group, which omits the Explorer pane. Readers accept both: a full-length entry is used as is,
 * and a content-only entry is spread around the Explorer pane's own allocation.
 */
export type SplitSizeOverlay = Record<string, number[]>;

/**
 * Remove the docked Explorer pane from the main split tree and apply the overlay's weights, so the
 * rendered tree and divider drags share one child order.
 *
 * @param node Root of the persisted layout.
 * @param explorerPaneId Pane rendered in the Explorer dock instead of the main tree, if any.
 * @param overlay Committed divider weights for this workspace.
 * @returns The main tree, or null when it has no panes left.
 */
export function projectMainSplitTree(
  node: SplitNode,
  explorerPaneId: string | null,
  overlay: SplitSizeOverlay | undefined,
): SplitNode | null {
  if (node.kind === "pane") {
    return node.pane.id === explorerPaneId ? null : node;
  }

  const retained = node.group.children.flatMap((child, sourceIndex) => {
    const projected = projectMainSplitTree(child, explorerPaneId, overlay);
    return projected ? [{ node: projected, sourceIndex }] : [];
  });
  if (retained.length === 0) {
    return null;
  }
  if (retained.length === 1) {
    return retained[0].node;
  }

  const saved = overlay?.[node.group.id];
  const renderedSaved = saved?.length === retained.length ? saved : undefined;
  const fullSizes = saved?.length === node.group.children.length ? saved : node.group.sizes;
  const projectedSizes = retained.map(({ sourceIndex }, renderedIndex) => {
    if (renderedSaved) {
      return renderedSaved[renderedIndex];
    }
    return fullSizes[sourceIndex];
  });
  const total = projectedSizes.reduce((sum, size) => sum + size, 0);
  return {
    kind: "group",
    group: {
      ...node.group,
      children: retained.map((child) => child.node),
      sizes: projectedSizes.map((size) => size / total),
    },
  };
}

/**
 * Write committed divider weights into the layout before a structural edit, so unrelated splits
 * keep their proportions.
 */
export function withCurrentSplitSizes(
  layout: WorkspaceLayout,
  overlay: SplitSizeOverlay,
  explorerPaneId: string | null,
): WorkspaceLayout {
  function update(node: SplitNode): SplitNode {
    if (node.kind === "pane") {
      return node;
    }
    const sizes = resolveCommittedGroupSizes(node.group, overlay[node.group.id], explorerPaneId);
    return {
      kind: "group",
      group: { ...node.group, sizes, children: node.group.children.map(update) },
    };
  }
  return { ...layout, root: update(layout.root) };
}

/** Bind each surviving group's overlay entry to its new child order after a structural edit. */
export function collectSplitSizes(root: SplitNode): SplitSizeOverlay {
  if (root.kind === "pane") {
    return {};
  }
  return Object.assign(
    { [root.group.id]: root.group.sizes },
    ...root.group.children.map(collectSplitSizes),
  );
}

/** One group's weights after applying its overlay entry, in either accepted shape. */
function resolveCommittedGroupSizes(
  group: SplitGroup,
  saved: number[] | undefined,
  explorerPaneId: string | null,
): number[] {
  if (!saved) {
    return group.sizes;
  }
  if (saved.length === group.children.length) {
    return clampNormalizedSizes(saved);
  }
  if (!explorerPaneId) {
    return group.sizes;
  }
  const explorerIndex = group.children.findIndex(
    (child) => child.kind === "pane" && child.pane.id === explorerPaneId,
  );
  const savedIsContentOnly = explorerIndex >= 0 && saved.length === group.children.length - 1;
  if (!savedIsContentOnly) {
    return group.sizes;
  }
  return projectContentSizesAroundExplorer(group.sizes, saved, explorerIndex);
}

/**
 * Spread content-only weights over the group while the Explorer pane keeps its current share.
 *
 * @param groupSizes Current weights of every child, including the Explorer pane.
 * @param contentSizes Committed weights of the other children, in order.
 * @param explorerIndex Index of the Explorer pane among the group's children.
 */
function projectContentSizesAroundExplorer(
  groupSizes: number[],
  contentSizes: number[],
  explorerIndex: number,
): number[] {
  const contentTotal = 1 - groupSizes[explorerIndex];
  const normalized = clampNormalizedSizes(contentSizes);
  return groupSizes.map((size, index) => {
    if (index === explorerIndex) {
      return size;
    }
    const contentIndex = index < explorerIndex ? index : index - 1;
    return normalized[contentIndex] * contentTotal;
  });
}
