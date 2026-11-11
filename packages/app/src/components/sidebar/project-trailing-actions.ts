/** Width and height of each project row action: the new workspace button and the kebab. */
export const PROJECT_ACTION_SIZE = 24;
/** Space between adjacent project row actions. */
export const PROJECT_ACTION_GAP = 2;
/**
 * How far the actions row is pulled right past the row padding. The kebab glyph paints only the
 * middle of its 14px view box, so the pull puts its dots, not its box, on the row's trailing rail.
 */
export const PROJECT_ACTION_OPTICAL_OFFSET = 6;
/**
 * Touch-sized layouts (phones, and any device with a touch screen) get a larger kebab tap target.
 * It overhangs the 24px box equally on every side, so its dots stay on the pointer layout's rail
 * and the row keeps its height; only its left edge takes extra width.
 */
export const PROJECT_KEBAB_TOUCH_SIZE = 32;
export const PROJECT_KEBAB_TOUCH_OVERHANG = (PROJECT_KEBAB_TOUCH_SIZE - PROJECT_ACTION_SIZE) / 2;

/**
 * The width the hover reveal reserves for a project row's actions, in pixels.
 *
 * It mirrors the actions row's layout: one box per action, gaps between them, the touch
 * kebab's extra left overhang, minus the optical pull that moves the row onto the rail.
 *
 * @param hasNewWorkspaceAction whether the row shows the new workspace button.
 * @param hasKebab whether the row shows the project kebab menu.
 * @param touchSizing whether the touch-sized kebab is in use.
 */
export function projectTrailingActionsWidth({
  hasNewWorkspaceAction,
  hasKebab,
  touchSizing,
}: {
  hasNewWorkspaceAction: boolean;
  hasKebab: boolean;
  touchSizing: boolean;
}): number {
  const actionCount = Number(hasNewWorkspaceAction) + Number(hasKebab);
  const gaps = Math.max(0, actionCount - 1) * PROJECT_ACTION_GAP;
  const hasTouchKebab = hasKebab && touchSizing;
  const kebabOverhang = hasTouchKebab ? PROJECT_KEBAB_TOUCH_OVERHANG : 0;
  const width = actionCount * PROJECT_ACTION_SIZE + gaps + kebabOverhang;
  return Math.max(0, width - PROJECT_ACTION_OPTICAL_OFFSET);
}
