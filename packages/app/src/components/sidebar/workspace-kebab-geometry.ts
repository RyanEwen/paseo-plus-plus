/** Desktop width and height of the workspace row kebab trigger. */
export const WORKSPACE_KEBAB_SIZE = 18;
/** Compact layouts get a larger kebab tap target. */
export const WORKSPACE_KEBAB_COMPACT_SIZE = 32;
/** Space between the kebab and the status beside it. */
export const WORKSPACE_KEBAB_LEADING_GAP = 2;
/**
 * How far the kebab is pulled right through the unused part of its view box. The glyph paints only
 * its middle, so the pull puts the dots, not the padded box, on the row's trailing rail.
 */
export const WORKSPACE_KEBAB_OPTICAL_PULL = 7;
export const WORKSPACE_KEBAB_COMPACT_OPTICAL_PULL = 14;

/**
 * The width the hover reveal reserves for a workspace row's kebab, in pixels.
 *
 * It mirrors the trigger's flow width in the row: its box plus the leading gap, minus the optical
 * pull, so the revealed space matches the space the trigger occupies at each breakpoint.
 *
 * @param compact whether the compact layout's larger kebab is in use.
 */
export function workspaceKebabRevealWidth({ compact }: { compact: boolean }): number {
  if (compact) {
    return WORKSPACE_KEBAB_COMPACT_SIZE + WORKSPACE_KEBAB_LEADING_GAP - WORKSPACE_KEBAB_COMPACT_OPTICAL_PULL;
  }
  return WORKSPACE_KEBAB_SIZE + WORKSPACE_KEBAB_LEADING_GAP - WORKSPACE_KEBAB_OPTICAL_PULL;
}
