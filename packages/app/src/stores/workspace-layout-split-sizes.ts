import {
  clampNormalizedSizes,
  type SplitGroup,
  type SplitNode,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-actions";

/**
 * Committed divider weights per split group, keyed by group id (`splitSizesByWorkspace[workspace]`).
 *
 * Each entry holds the weights of the group's rendered children, so a docked Explorer pane has no
 * entry of its own. Layouts saved before this shape are converted once on load by
 * `convertSavedSplitSizes`.
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
  const projectedSizes = retained.map(({ sourceIndex }, renderedIndex) => {
    if (renderedSaved) {
      return renderedSaved[renderedIndex];
    }
    return node.group.sizes[sourceIndex];
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
export function collectSplitSizes(
  root: SplitNode,
  explorerPaneId: string | null,
): SplitSizeOverlay {
  if (root.kind === "pane") {
    return {};
  }
  const explorerIndex = findExplorerIndex(root.group, explorerPaneId);
  const sizes =
    explorerIndex >= 0 ? removeExplorerShare(root.group.sizes, explorerIndex) : root.group.sizes;
  return Object.assign(
    { [root.group.id]: sizes },
    ...root.group.children.map((child) => collectSplitSizes(child, explorerPaneId)),
  );
}

/**
 * Convert overlay entries saved with an Explorer share into the rendered-children shape.
 * Safe on every load: entries already in that shape, and groups no longer in the tree, are kept.
 *
 * @param saved Persisted overlays by workspace key.
 * @param layouts Restored layouts by workspace key.
 * @param explorerPaneIds Docked Explorer pane by workspace key.
 */
export function convertSavedSplitSizes(
  saved: Record<string, SplitSizeOverlay>,
  layouts: Record<string, WorkspaceLayout>,
  explorerPaneIds: Record<string, string | null>,
): Record<string, SplitSizeOverlay> {
  const converted: Record<string, SplitSizeOverlay> = {};
  for (const [workspaceKey, overlay] of Object.entries(saved)) {
    const layout = layouts[workspaceKey];
    converted[workspaceKey] = layout
      ? convertOverlay(layout.root, overlay, explorerPaneIds[workspaceKey] ?? null)
      : overlay;
  }
  return converted;
}

function convertOverlay(
  node: SplitNode,
  overlay: SplitSizeOverlay,
  explorerPaneId: string | null,
): SplitSizeOverlay {
  if (node.kind === "pane") {
    return overlay;
  }
  let result = overlay;
  const entry = overlay[node.group.id];
  const explorerIndex = findExplorerIndex(node.group, explorerPaneId);
  if (entry?.length === node.group.children.length && explorerIndex >= 0) {
    result = Object.assign({}, overlay, {
      [node.group.id]: removeExplorerShare(entry, explorerIndex),
    });
  }
  for (const child of node.group.children) {
    result = convertOverlay(child, result, explorerPaneId);
  }
  return result;
}

/** Index of the docked Explorer pane among a group's direct children, or -1. */
function findExplorerIndex(group: SplitGroup, explorerPaneId: string | null): number {
  if (!explorerPaneId) {
    return -1;
  }
  return group.children.findIndex(
    (child) => child.kind === "pane" && child.pane.id === explorerPaneId,
  );
}

/** Weights of the other children, rescaled to sum to 1. */
function removeExplorerShare(sizes: number[], explorerIndex: number): number[] {
  const content = sizes.filter((_size, index) => index !== explorerIndex);
  const total = content.reduce((sum, size) => sum + size, 0);
  if (total <= 0) {
    return content;
  }
  return content.map((size) => size / total);
}

/** One group's weights after applying its overlay entry. */
function resolveCommittedGroupSizes(
  group: SplitGroup,
  saved: number[] | undefined,
  explorerPaneId: string | null,
): number[] {
  if (!saved) {
    return group.sizes;
  }
  const explorerIndex = findExplorerIndex(group, explorerPaneId);
  if (explorerIndex < 0) {
    return saved.length === group.children.length ? clampNormalizedSizes(saved) : group.sizes;
  }
  if (saved.length !== group.children.length - 1) {
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
