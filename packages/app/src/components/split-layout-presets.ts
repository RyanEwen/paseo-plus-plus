import { isSplitFraction } from "@/stores/workspace-layout-splits";
import { computeResizeHandleSizes } from "./resize-handle-sizes";

/** Ratios read left-to-right for columns and top-to-bottom for rows. `id` is the label's test-id form. */
export const SPLIT_LAYOUT_PRESETS = [
  { id: "80-20", label: "80/20", fraction: 0.8 },
  { id: "70-30", label: "70/30", fraction: 0.7 },
  { id: "60-40", label: "60/40", fraction: 0.6 },
  { id: "50-50", label: "50/50", fraction: 0.5 },
  { id: "40-60", label: "40/60", fraction: 0.4 },
  { id: "30-70", label: "30/70", fraction: 0.3 },
  { id: "20-80", label: "20/80", fraction: 0.2 },
] as const;

/** Tolerance for comparing an applied share with the preset's labelled share. */
const PRESET_SHARE_EPSILON = 1e-9;

/** Preserve the adjacent pair's total and every other pane while honoring the normal drag minimum. */
export function applySplitLayoutPreset(sizes: number[], index: number, fraction: number): number[] {
  if (!isSplitFraction(fraction)) {
    return sizes.slice();
  }
  const first = sizes[index];
  const second = sizes[index + 1];
  if (first === undefined || second === undefined) {
    return sizes.slice();
  }
  return computeResizeHandleSizes({
    sizes,
    index,
    deltaRatio: (first + second) * fraction - first,
  });
}

/**
 * Disable choices that cannot fit beside this divider rather than silently selecting a different
 * ratio. A preset fits exactly when applying it yields its labelled share, so this check cannot
 * drift from the clamp the apply path uses.
 */
export function canApplySplitLayoutPreset(
  sizes: number[],
  index: number,
  fraction: number,
): boolean {
  const first = sizes[index];
  const second = sizes[index + 1];
  if (first === undefined || second === undefined || !isSplitFraction(fraction)) {
    return false;
  }
  const pair = first + second;
  if (!Number.isFinite(pair) || pair <= 0) {
    return false;
  }
  const applied = applySplitLayoutPreset(sizes, index, fraction);
  const appliedFirst = applied[index] ?? first;
  return Math.abs(appliedFirst - pair * fraction) < PRESET_SHARE_EPSILON;
}
