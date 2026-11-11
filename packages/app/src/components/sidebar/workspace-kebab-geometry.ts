import type { SizingValue } from "@/components/ui/control-geometry";

/** Width and height of the workspace row kebab trigger, by control sizing. */
export const WORKSPACE_KEBAB_SIZE: SizingValue = { touch: 32, pointer: 18 };
/**
 * How far the kebab is pulled right through the unused part of its view box. The glyph paints only
 * its middle, so the pull puts the dots, not the padded box, on the row's trailing rail.
 */
export const WORKSPACE_KEBAB_OPTICAL_PULL: SizingValue = { touch: 14, pointer: 7 };

/**
 * The width the hover reveal reserves for a workspace row's actions, in pixels.
 *
 * It mirrors the actions' flow width in the row: the kebab's box minus its optical pull, plus the
 * one-click archive button and its gap when that button shows.
 *
 * @param touchSizing whether the touch-sized kebab is in use.
 * @param archiveButtonFootprint the archive button's width and gap, or 0 when it is hidden.
 */
export function workspaceTrailingActionsRevealWidth({
  touchSizing,
  archiveButtonFootprint,
}: {
  touchSizing: boolean;
  archiveButtonFootprint: number;
}): number {
  const sizing = touchSizing ? "touch" : "pointer";
  const kebabWidth = WORKSPACE_KEBAB_SIZE[sizing] - WORKSPACE_KEBAB_OPTICAL_PULL[sizing];
  return archiveButtonFootprint + kebabWidth;
}
