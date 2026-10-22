import type { PaneHost } from "@/panels/panel-manifest";
export const MIN_WORKSPACE_TAB_WIDTH = 96;

/** Desktop main/sheet tabs retain the fork minimum; compact chips use the upstream touch layout. */
export function workspaceTabMinimumWidth(host: PaneHost, compact: boolean): number {
  if (compact || host === "explorer") return 64;
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
  /** Compact chips keep natural widths and close through their menu. */
  compact: boolean;
  /** Raise only the title-width ceiling; short tabs stay content-driven. */
  widerTabs?: boolean;
  iconOnly?: boolean;
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
  const tabChromeWidth =
    input.metrics.tabIconWidth +
    input.metrics.tabContentGap +
    input.metrics.tabHorizontalPadding * 2 +
    input.metrics.closeButtonWidth;
  const maximumWidth = input.metrics.maxTabWidth * (input.widerTabs ? 1.5 : 1);
  if (input.iconOnly) {
    const width = Math.max(input.metrics.tabIconWidth, input.iconOnlyTabWidth ?? 44);
    return {
      items: input.tabLabelWidths.map(() => ({ width, showLabel: false })),
      closeButtonPolicy,
      requiresHorizontalScrollFallback: availableTabsWidth < width * tabCount,
    };
  }
  const naturalWidths = input.tabLabelWidths.map((labelWidth) =>
    clamp(tabChromeWidth + labelWidth, input.metrics.minTabWidth, maximumWidth),
  );
  const naturalTotalWidth = naturalWidths.reduce((total, width) => total + width, 0);
  const minimumTotalWidth = input.metrics.minTabWidth * tabCount;
  // A row that scrolls has no reason to truncate: the tabs keep their natural widths and the
  // viewport pans over them. Pointer layouts first shrink toward the clickable minimum and scroll
  // only once even that does not fit; compact layouts skip the shrink.
  const requiresHorizontalScrollFallback = input.compact
    ? naturalTotalWidth > availableTabsWidth
    : availableTabsWidth < minimumTotalWidth;

  let resolvedWidths = naturalWidths;
  if (
    !requiresHorizontalScrollFallback &&
    !input.compact &&
    naturalTotalWidth > availableTabsWidth
  ) {
    const widthToRemove = naturalTotalWidth - availableTabsWidth;
    const shrinkCapacity = naturalTotalWidth - minimumTotalWidth;
    const shrinkRatio = widthToRemove / shrinkCapacity;
    resolvedWidths = naturalWidths.map(
      (width) => width - (width - input.metrics.minTabWidth) * shrinkRatio,
    );
  }

  const roundedWidths = resolvedWidths.map((width) =>
    Math.round(clamp(width, input.metrics.minTabWidth, maximumWidth)),
  );

  return {
    items: roundedWidths.map((width) => ({
      width,
      showLabel: width > tabChromeWidth,
    })),
    closeButtonPolicy,
    requiresHorizontalScrollFallback,
  };
}

/** Reveal the selected tab with the smallest movement, clamped to the measured scroll range. */
export function resolveWorkspaceTabScrollOffset(input: {
  offset: number;
  viewportWidth: number;
  contentWidth: number;
  tabStart: number;
  tabWidth: number;
}): number {
  const { offset, viewportWidth, contentWidth, tabStart, tabWidth } = input;
  if (viewportWidth <= 0 || contentWidth <= 0) {
    return offset;
  }

  let nextOffset = offset;
  if (tabStart < offset || tabWidth > viewportWidth) {
    nextOffset = tabStart;
  } else if (tabStart + tabWidth > offset + viewportWidth) {
    nextOffset = tabStart + tabWidth - viewportWidth;
  }

  return clamp(nextOffset, 0, Math.max(0, contentWidth - viewportWidth));
}
