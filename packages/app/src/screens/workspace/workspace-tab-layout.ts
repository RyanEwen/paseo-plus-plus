import type { PaneHost } from "@/panels/panel-manifest";

/** Paseo++ minimum for main and sheet tabs on wide layouts, so short names stay easy to click. */
export const MIN_WORKSPACE_TAB_WIDTH = 96;
/** Upstream's tab minimum, kept wherever the wider fork minimum does not fit. */
const UPSTREAM_TAB_MIN_WIDTH = 64;

/**
 * The narrowest a labelled tab may become in `host` before its strip scrolls.
 *
 * Wide main and sheet panes use the fork minimum. Compact chips keep upstream's touch layout, and
 * the Explorer keeps upstream's minimum because its dock can be as narrow as 240 points, where
 * 96-point tabs would make the strip scroll after a single tab.
 */
export function workspaceTabMinimumWidth(host: PaneHost, compact: boolean): number {
  if (compact || host === "explorer") {
    return UPSTREAM_TAB_MIN_WIDTH;
  }
  return MIN_WORKSPACE_TAB_WIDTH;
}

export type WorkspaceTabCloseButtonPolicy = "all" | "none";

export interface WorkspaceTabLayoutMetrics {
  rowHorizontalInset: number;
  actionsReservedWidth: number;
  rowPaddingHorizontal: number;
  tabGap: number;
  minTabWidth: number;
  maxTabWidth: number;
  tabIconWidth: number;
  tabContentGap: number;
  tabHorizontalPadding: number;
  closeButtonWidth: number;
}

export interface WorkspaceTabLayoutInput {
  viewportWidth: number;
  tabLabelWidths: number[];
  metrics: WorkspaceTabLayoutMetrics;
  /**
   * Compact layouts are touch-first. Tabs keep their natural width and the row scrolls as soon as
   * they overflow, so a label is never squeezed to make room; chips carry no inline close because a
   * narrow X beside the label is easy to hit by accident and the tab's long-press menu closes it.
   */
  compact: boolean;
  /** Raise only the title-width ceiling; short tabs stay content-driven. */
  widerTabs?: boolean;
  /** Present for icon-only tabs: every tab is a square cell of this width with no label. */
  iconOnlyTabWidth?: number;
}

export interface WorkspaceTabLayoutItem {
  width: number;
  showLabel: boolean;
}

export interface WorkspaceTabLayoutResult {
  items: WorkspaceTabLayoutItem[];
  closeButtonPolicy: WorkspaceTabCloseButtonPolicy;
  requiresHorizontalScrollFallback: boolean;
}

export function retainWorkspaceTabMeasuredWidth(
  currentWidth: number,
  measuredWidth: number,
): number {
  if (measuredWidth <= 0 || Math.abs(currentWidth - measuredWidth) <= 1) {
    return currentWidth;
  }
  return measuredWidth;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

export function computeWorkspaceTabLayout(
  input: WorkspaceTabLayoutInput,
): WorkspaceTabLayoutResult {
  const tabCount = input.tabLabelWidths.length;
  const closeButtonPolicy: WorkspaceTabCloseButtonPolicy = input.compact ? "none" : "all";
  if (tabCount === 0) {
    return {
      items: [],
      closeButtonPolicy,
      requiresHorizontalScrollFallback: false,
    };
  }

  const availableWidth = Math.max(
    0,
    input.viewportWidth - input.metrics.rowHorizontalInset * 2 - input.metrics.actionsReservedWidth,
  );
  const rowOverhead =
    input.metrics.rowPaddingHorizontal * 2 + Math.max(tabCount - 1, 0) * input.metrics.tabGap;
  const availableTabsWidth = Math.max(0, availableWidth - rowOverhead);
  if (input.iconOnlyTabWidth !== undefined) {
    const width = input.iconOnlyTabWidth;
    return {
      items: input.tabLabelWidths.map(() => ({ width, showLabel: false })),
      // A square cell has no room for an inline X; icon-only tabs close from their context menu.
      closeButtonPolicy: "none",
      requiresHorizontalScrollFallback: availableTabsWidth < width * tabCount,
    };
  }
  const tabChromeWidth =
    input.metrics.tabIconWidth +
    input.metrics.tabContentGap +
    input.metrics.tabHorizontalPadding * 2 +
    input.metrics.closeButtonWidth;
  const maximumWidth = input.metrics.maxTabWidth * (input.widerTabs ? 1.5 : 1);
  const naturalWidths = input.tabLabelWidths.map((labelWidth) =>
    clamp(tabChromeWidth + labelWidth, input.metrics.minTabWidth, maximumWidth),
  );
  const naturalTotalWidth = naturalWidths.reduce((total, width) => total + width, 0);
  // Tabs always keep their natural widths, so a title is never squeezed; the strip scrolls as soon
  // as those widths do not fit. The minimum only floors short names.
  const requiresHorizontalScrollFallback = naturalTotalWidth > availableTabsWidth;
  const roundedWidths = naturalWidths.map((width) => Math.round(width));

  return {
    items: roundedWidths.map((width) => ({
      width,
      showLabel: width > tabChromeWidth,
    })),
    closeButtonPolicy,
    requiresHorizontalScrollFallback,
  };
}
