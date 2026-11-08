import {
  findPaneById,
  splitPaneEmptyInLayout,
  splitPaneInLayout,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-actions";
import type { SplitDirection } from "@/stores/workspace-layout-splits";

/**
 * Directions in which splitting a pane would exceed the depth limit.
 *
 * Runs the real split on a discarded copy, so the answer cannot drift from what a press does.
 * Both sides of an axis build the same depth, so one side per direction is enough.
 *
 * @param input.tabId Tab being moved into the split; omitted when the split creates a new tab.
 */
export function resolveBlockedSplitDirections(input: {
  layout: WorkspaceLayout;
  targetPaneId: string;
  tabId?: string;
  maxTreeDepth: number;
}): ReadonlySet<SplitDirection> {
  const blocked = new Set<SplitDirection>();
  if (!findPaneById(input.layout.root, input.targetPaneId)) {
    return blocked;
  }
  if (!canSplit(input, "left")) {
    blocked.add("horizontal");
  }
  if (!canSplit(input, "top")) {
    blocked.add("vertical");
  }
  return blocked;
}

function canSplit(
  input: { layout: WorkspaceLayout; targetPaneId: string; tabId?: string; maxTreeDepth: number },
  position: "left" | "top",
): boolean {
  const probe = {
    layout: input.layout,
    targetPaneId: input.targetPaneId,
    position,
    maxTreeDepth: input.maxTreeDepth,
    createNodeId: (prefix: string) => `split-depth-probe-${prefix}`,
  };
  if (input.tabId) {
    return splitPaneInLayout({ ...probe, tabId: input.tabId }) !== null;
  }
  return splitPaneEmptyInLayout(probe) !== null;
}
