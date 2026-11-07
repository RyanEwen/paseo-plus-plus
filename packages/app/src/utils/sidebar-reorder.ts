import type { SidebarViewStoreState } from "@/stores/sidebar-view-store";
import type { DragReorderMove } from "@/components/drag-reorder/reorder-items";

export function mergeWithRemainder(input: {
  currentOrder: string[];
  reorderedVisibleKeys: string[];
}): string[] {
  const reorderedSet = new Set(input.reorderedVisibleKeys);
  const remainder = input.currentOrder.filter((key) => !reorderedSet.has(key));
  return [...input.reorderedVisibleKeys, ...remainder];
}

export function hasVisibleOrderChanged(input: {
  currentOrder: string[];
  reorderedVisibleKeys: string[];
}): boolean {
  const visibleSet = new Set(input.reorderedVisibleKeys);
  const currentVisible = input.currentOrder.filter((key) => visibleSet.has(key));
  if (currentVisible.length !== input.reorderedVisibleKeys.length) {
    return true;
  }
  return input.reorderedVisibleKeys.some((key, index) => currentVisible[index] !== key);
}

/**
 * Resolve one project-workspace drop into the preference it should write.
 *
 * Persist only the actual dragged sibling; passive visible overflow is not a move. A dragged
 * project pin returns the new pin order (`pinOrder`) and leaves the saved workspace order alone;
 * an ordinary drag returns the new full workspace order and no pin order, so pins that were
 * never dragged keep their newest-first recency order. Both are null for an invalid drop.
 */
export function resolveProjectWorkspaceReorder(input: {
  currentVisibleKeys: string[];
  reorderedVisibleKeys: string[];
  projectPinnedKeys: ReadonlySet<string>;
  storedWorkspaceOrder: string[];
  move: DragReorderMove;
}): { pinOrder: string[] | null; workspaceOrder: string[] | null } {
  if (!isProjectWorkspaceMoveValid(input)) return { pinOrder: null, workspaceOrder: null };
  if (input.projectPinnedKeys.has(input.move.activeKey)) {
    const pinOrder = input.reorderedVisibleKeys.filter((key) => input.projectPinnedKeys.has(key));
    return { pinOrder, workspaceOrder: null };
  }
  // Manual reconciliation owns new ranks. A stale ordinary gesture cannot invent their order.
  const savedKeys = new Set(input.storedWorkspaceOrder);
  if (input.currentVisibleKeys.some((key) => !savedKeys.has(key)))
    return { pinOrder: null, workspaceOrder: null };
  return {
    pinOrder: null,
    workspaceOrder: moveProjectInFullOrder({
      currentOrder: input.storedWorkspaceOrder,
      knownProjectKeys: input.currentVisibleKeys,
      move: input.move,
    }),
  };
}

/** The actual list owns the indices and partition; absent or stale anchors cannot commit. */
function isProjectWorkspaceMoveValid(input: {
  currentVisibleKeys: string[];
  reorderedVisibleKeys: string[];
  projectPinnedKeys: ReadonlySet<string>;
  move: DragReorderMove;
}): boolean {
  const { activeKey, overKey, from, to } = input.move;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from === to) return false;
  const reorderedSet = new Set(input.reorderedVisibleKeys);
  if (reorderedSet.size !== input.reorderedVisibleKeys.length) return false;
  const original = input.currentVisibleKeys.filter((key) => reorderedSet.has(key));
  if (
    original.length !== input.reorderedVisibleKeys.length ||
    original[from] !== activeKey ||
    original[to] !== overKey
  )
    return false;
  const pinMove = input.projectPinnedKeys.has(activeKey);
  if (
    original
      .slice(Math.min(from, to), Math.max(from, to) + 1)
      .some((key) => input.projectPinnedKeys.has(key) !== pinMove)
  )
    return false;
  const expected = original.slice();
  expected.splice(from, 1);
  expected.splice(to, 0, activeKey);
  return expected.every((key, index) => key === input.reorderedVisibleKeys[index]);
}

/** Move only the dragged project relative to its actual anchor; all other siblings stay ordered. */
export function moveProjectInFullOrder({
  currentOrder,
  knownProjectKeys,
  move,
}: {
  currentOrder: readonly string[];
  knownProjectKeys: readonly string[];
  move: DragReorderMove;
}): string[] | null {
  if (move.from === move.to || move.activeKey === move.overKey) return null;
  const order = [...new Set([...currentOrder, ...knownProjectKeys])];
  if (!order.includes(move.activeKey) || !order.includes(move.overKey)) return null;
  const remaining = order.filter((key) => key !== move.activeKey);
  const anchorIndex = remaining.indexOf(move.overKey);
  remaining.splice(anchorIndex + (move.from < move.to ? 1 : 0), 0, move.activeKey);
  return remaining;
}

export type SidebarReorderDomain = "project" | "workspace";
type SidebarReorderView = Pick<
  SidebarViewStoreState,
  | "groupMode"
  | "sortMode"
  | "emptyProjectSortMode"
  | "workspaceSortMode"
  | "workspaceSort"
  | "hostFilters"
  | "projectFilters"
  | "labelFilter"
  | "showBackground"
  | "projectVisibility"
  | "groupEmptyProjects"
>;

export function sidebarReorderSort(view: SidebarReorderView, domain: SidebarReorderDomain): string {
  if (domain === "workspace") {
    if (view.groupMode === "project" && view.workspaceSort !== "manual") return view.workspaceSort;
    return view.workspaceSortMode;
  }
  return view.groupMode === "project" ? view.sortMode : view.emptyProjectSortMode;
}

/** The rendered domain must still own a drop; cached directory additions are not a filter change. */
export function sidebarReorderContext(
  view: SidebarReorderView,
  domain: SidebarReorderDomain,
  quickFilterText = "",
): string {
  return JSON.stringify([
    view.groupMode,
    quickFilterText.trim().toLowerCase(),
    sidebarReorderSort(view, domain),
    view.hostFilters,
    view.projectFilters,
    view.labelFilter,
    view.showBackground,
    view.projectVisibility,
    view.groupEmptyProjects,
  ]);
}

export function canCommitSidebarReorder(input: {
  startedContext: string | null;
  currentContext: string;
  sort: string;
  manualPins?: boolean;
}): boolean {
  return (
    input.startedContext !== null &&
    input.startedContext === input.currentContext &&
    (input.manualPins === true || input.sort === "custom")
  );
}
