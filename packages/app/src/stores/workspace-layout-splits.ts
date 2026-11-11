/** Edge of the target pane where a new split pane is placed. */
export type SplitSide = "left" | "right" | "top" | "bottom";

/** Axis along which a split divides its panes: side by side, or stacked. */
export type SplitDirection = "horizontal" | "vertical";

/** Share of the left or top pane in a two-pane split, strictly between 0 and 1. */
export function isSplitFraction(fraction: number): boolean {
  return Number.isFinite(fraction) && fraction > 0 && fraction < 1;
}

/** Sizes of a new two-pane group whose left or top pane takes `firstFraction`. */
export function pairSizes(firstFraction: number): number[] {
  return [firstFraction, 1 - firstFraction];
}

/**
 * Split one child of a group into a new pane and the target, keeping the target's total share.
 *
 * @param input.sizes Current sizes of the group's children.
 * @param input.targetIndex Index of the pane being split.
 * @param input.insertAfter True when the new pane goes right of or below the target.
 * @param input.firstFraction Share of the left or top pane of the resulting pair.
 * @returns The group's sizes with the new pane's entry inserted.
 */
export function insertPairSizes(input: {
  sizes: number[];
  targetIndex: number;
  insertAfter: boolean;
  firstFraction: number;
}): number[] {
  const { sizes, targetIndex, insertAfter, firstFraction } = input;
  const targetSize = sizes[targetIndex] ?? 0;
  const secondFraction = 1 - firstFraction;
  const newPaneShare = insertAfter ? secondFraction : firstFraction;
  const targetShare = insertAfter ? firstFraction : secondFraction;
  const insertIndex = insertAfter ? targetIndex + 1 : targetIndex;
  const targetIndexAfterInsert = insertAfter ? targetIndex : targetIndex + 1;

  const nextSizes = sizes.slice();
  nextSizes.splice(insertIndex, 0, targetSize * newPaneShare);
  nextSizes[targetIndexAfterInsert] = targetSize * targetShare;
  return nextSizes;
}
