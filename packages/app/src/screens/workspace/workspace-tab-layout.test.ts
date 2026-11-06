import {
  WorkspaceHeaderExplorerToggle,
  WorkspaceExplorerSidebarToggle,
} from "./workspace-explorer-toggle";
import { describe, expect, it } from "vitest";
import { SidebarCloseButton } from "@/components/headers/sidebar-close-button";
import { resolveWorkspaceTabChipBackdrop } from "@/screens/workspace/workspace-tab-chip-backdrop";
import { darkPureBlackTheme, darkTheme, lightTheme } from "@/styles/theme";
import {
  MIN_WORKSPACE_TAB_WIDTH,
  workspaceTabMinimumWidth,
  resolveWorkspaceTabScrollOffset,
  computeWorkspaceTabLayout,
  retainWorkspaceTabMeasuredWidth,
} from "@/screens/workspace/workspace-tab-layout";

const metrics = {
  rowHorizontalInset: 0,
  actionsReservedWidth: 120,
  rowPaddingHorizontal: 8,
  tabGap: 4,
  minTabWidth: 64,
  maxTabWidth: 160,
  tabIconWidth: 14,
  tabContentGap: 4,
  tabHorizontalPadding: 8,
  closeButtonWidth: 0,
};

const compactFillMetrics = {
  ...metrics,
  actionsReservedWidth: 0,
  rowPaddingHorizontal: 0,
  tabGap: 0,
};

describe("computeWorkspaceTabLayout", () => {
  it.each([
    { tabCount: 2, width: 150, scrolling: false },
    { tabCount: 4, width: 75, scrolling: false },
    { tabCount: 5, width: 64, scrolling: true },
  ])("fills a 300px compact track with $tabCount equal tabs", ({ tabCount, width, scrolling }) => {
    const result = computeWorkspaceTabLayout({
      compact: true,
      fillAvailableWidth: true,
      viewportWidth: 300,
      tabLabelWidths: Array.from({ length: tabCount }, (_, index) => index * 200),
      metrics: compactFillMetrics,
    });

    expect(result.items).toEqual(
      Array.from({ length: tabCount }, () => ({ width, showLabel: true })),
    );
    expect(result.requiresHorizontalScrollFallback).toBe(scrolling);
    expect(result.closeButtonPolicy).toBe("none");
  });

  it("uses measured track padding and both outer half-gaps at the compact minimum boundary", () => {
    const input = {
      compact: true,
      fillAvailableWidth: true,
      viewportWidth: 220,
      tabLabelWidths: [0, 400, 800],
      metrics: { ...compactFillMetrics, rowPaddingHorizontal: 8, tabGap: 4 },
    };
    const exact = computeWorkspaceTabLayout(input);
    const overflow = computeWorkspaceTabLayout({ ...input, viewportWidth: 219 });

    expect(exact.items.map((item) => item.width)).toEqual([64, 64, 64]);
    expect(exact.requiresHorizontalScrollFallback).toBe(false);
    expect(overflow.items).toEqual(exact.items);
    expect(overflow.requiresHorizontalScrollFallback).toBe(true);
  });

  it("fills a single compact tab beyond the title ceiling regardless of the wider-tabs preference", () => {
    const input = {
      compact: true,
      fillAvailableWidth: true,
      viewportWidth: 500,
      tabLabelWidths: [800],
      metrics: compactFillMetrics,
    };
    const result = computeWorkspaceTabLayout(input);

    expect(result.items).toEqual([{ width: 500, showLabel: true }]);
    expect(result.requiresHorizontalScrollFallback).toBe(false);
    expect(computeWorkspaceTabLayout({ ...input, widerTabs: true })).toEqual(result);
  });

  it("keeps fractional compact shares within the measured width", () => {
    const result = computeWorkspaceTabLayout({
      compact: true,
      fillAvailableWidth: true,
      viewportWidth: 301,
      tabLabelWidths: [0, 100, 800],
      metrics: compactFillMetrics,
    });

    expect(result.items.map((item) => item.width)).toEqual([301 / 3, 301 / 3, 301 / 3]);
    expect(result.items.reduce((sum, item) => sum + item.width, 0)).toBeCloseTo(301);
    expect(result.requiresHorizontalScrollFallback).toBe(false);
  });

  it("retains desktop natural-width sizing when compact fill is requested", () => {
    const input = {
      compact: false,
      viewportWidth: 1000,
      tabLabelWidths: [29, 400],
      metrics,
    };

    expect(computeWorkspaceTabLayout({ ...input, fillAvailableWidth: true })).toEqual(
      computeWorkspaceTabLayout(input),
    );
  });

  it("exempts Explorer from workspace minimum widths on wide and compact layouts", () => {
    expect(workspaceTabMinimumWidth("main", false)).toBe(96);
    expect(workspaceTabMinimumWidth("main", true)).toBe(64);
    expect(workspaceTabMinimumWidth("sheet", false)).toBe(96);
    expect(workspaceTabMinimumWidth("sheet", true)).toBe(64);
    expect(workspaceTabMinimumWidth("explorer", false)).toBe(64);
    expect(workspaceTabMinimumWidth("explorer", true)).toBe(64);
    const result = computeWorkspaceTabLayout({
      compact: false,
      viewportWidth: 220,
      tabLabelWidths: [29, 52],
      metrics: {
        ...metrics,
        actionsReservedWidth: 36,
        minTabWidth: workspaceTabMinimumWidth("explorer", false),
      },
    });
    expect(result.items.map((item) => item.width)).toEqual([64, 86]);
    expect(result.requiresHorizontalScrollFallback).toBe(false);
  });
  it("uses square desktop icons independent of titles and scrolls when the strip is full", () => {
    const input = {
      compact: false,
      viewportWidth: 230,
      tabLabelWidths: [29, 52, 400],
      metrics: { ...metrics, actionsReservedWidth: 36, closeButtonWidth: 20 },
      iconOnly: true,
      iconOnlyTabWidth: 28,
    };
    const result = computeWorkspaceTabLayout(input);
    expect(result.items).toEqual(
      Array.from({ length: 3 }, () => ({ width: 28, showLabel: false })),
    );
    expect(result.closeButtonPolicy).toBe("all");
    expect(result.requiresHorizontalScrollFallback).toBe(false);
    expect(
      computeWorkspaceTabLayout({ ...input, viewportWidth: 120 }).requiresHorizontalScrollFallback,
    ).toBe(true);
    expect(
      computeWorkspaceTabLayout({ ...input, iconOnly: false }).items.some((item) => item.showLabel),
    ).toBe(true);
  });
  it("keeps icon-only tabs touch-sized on compact layouts without label or close-button allowance", () => {
    const result = computeWorkspaceTabLayout({
      compact: true,
      viewportWidth: 240,
      tabLabelWidths: [400, 800],
      metrics: { ...metrics, actionsReservedWidth: 44, closeButtonWidth: 44 },
      iconOnly: true,
      iconOnlyTabWidth: 44,
    });
    expect(result.items).toEqual([
      { width: 44, showLabel: false },
      { width: 44, showLabel: false },
    ]);
    expect(result.requiresHorizontalScrollFallback).toBe(false);
  });
  it("keeps short desktop tab names at the fork minimum width", () => {
    const result = computeWorkspaceTabLayout({
      compact: false,
      viewportWidth: 1200,
      tabLabelWidths: [0, 29, 52, 400],
      metrics: { ...metrics, minTabWidth: MIN_WORKSPACE_TAB_WIDTH },
    });
    expect(result.items.map((item) => item.width)).toEqual([96, 96, 96, 160]);
    expect(result.requiresHorizontalScrollFallback).toBe(false);
  });
  it("scrolls instead of shrinking desktop tabs below the fork minimum", () => {
    const result = computeWorkspaceTabLayout({
      compact: false,
      viewportWidth: 260,
      tabLabelWidths: [29, 52, 180],
      metrics: { ...metrics, minTabWidth: MIN_WORKSPACE_TAB_WIDTH },
    });
    expect(result.items.map((item) => item.width)).toEqual([96, 96, 160]);
    expect(result.requiresHorizontalScrollFallback).toBe(true);
    expect(result.items.every((item) => item.showLabel)).toBe(true);
  });

  it("raises the title ceiling by 50% without stretching short tabs", () => {
    const normal = computeWorkspaceTabLayout({
      compact: false,
      viewportWidth: 1200,
      tabLabelWidths: [30, 400],
      metrics,
    });
    const wider = computeWorkspaceTabLayout({
      compact: false,
      viewportWidth: 1200,
      tabLabelWidths: [30, 400],
      metrics,
      widerTabs: true,
    });
    expect(normal.items.map((item) => item.width)).toEqual([64, 160]);
    expect(wider.items.map((item) => item.width)).toEqual([64, 240]);
  });

  it("uses the compact ceiling and preserves scrolling when wider tabs are enabled", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 390,
      tabLabelWidths: [400, 400],
      metrics: { ...metrics, minTabWidth: 120, maxTabWidth: 240 },
      widerTabs: true,
      compact: true,
    });
    expect(result.items.map((item) => item.width)).toEqual([360, 360]);
    expect(result.requiresHorizontalScrollFallback).toBe(true);
    expect(result.closeButtonPolicy).toBe("none");
  });

  it("still compresses wider desktop tabs to fit the available pane", () => {
    const result = computeWorkspaceTabLayout({
      compact: false,
      viewportWidth: 400,
      tabLabelWidths: [400, 400],
      metrics,
      widerTabs: true,
    });
    expect(result.items.map((item) => item.width)).toEqual([130, 130]);
    expect(result.requiresHorizontalScrollFallback).toBe(false);
  });

  it("restores the earlier ceiling when the preference is disabled", () => {
    const input = { compact: false, viewportWidth: 1200, tabLabelWidths: [400], metrics };
    expect(computeWorkspaceTabLayout({ ...input, widerTabs: false })).toEqual(
      computeWorkspaceTabLayout(input),
    );
  });

  it("keeps each tab at its natural content width when space is available", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 1200,
      tabLabelWidths: [56, 70, 49],
      metrics,
      compact: false,
    });

    expect(result.closeButtonPolicy).toBe("all");
    expect(result.requiresHorizontalScrollFallback).toBe(false);
    expect(result.items).toHaveLength(3);
    expect(result.items.every((item) => item.showLabel)).toBe(true);
    expect(result.items.map((item) => item.width)).toEqual([90, 104, 83]);
  });

  it("lets short labels use their content width below the old 96px floor", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 300,
      tabLabelWidths: [29, 52],
      metrics: { ...metrics, actionsReservedWidth: 36 },
      compact: false,
    });
    expect(result.items).toEqual([
      { width: 64, showLabel: true },
      { width: 86, showLabel: true },
    ]);
    expect(result.requiresHorizontalScrollFallback).toBe(false);
  });

  it("sizes a single tab between the minimum and maximum from its content", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 1200,
      tabLabelWidths: [105],
      metrics,
      compact: false,
    });

    expect(result.requiresHorizontalScrollFallback).toBe(false);
    expect(result.items.map((item) => item.width)).toEqual([139]);
  });

  it("shrinks natural widths proportionally without crossing the clickable minimum", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 460,
      tabLabelWidths: [168, 84, 56],
      metrics,
      compact: false,
    });

    expect(result.closeButtonPolicy).toBe("all");
    expect(result.requiresHorizontalScrollFallback).toBe(false);
    expect(result.items.map((item) => item.width)).toEqual([132, 102, 82]);
    expect(result.items.every((item) => item.showLabel)).toBe(true);
  });

  it("caps long tabs at the maximum width", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 1004,
      tabLabelWidths: [280, 280, 280, 280],
      metrics: {
        ...metrics,
        actionsReservedWidth: 44,
        rowPaddingHorizontal: 0,
        tabGap: 0,
      },
      compact: false,
    });

    expect(result.closeButtonPolicy).toBe("all");
    expect(result.requiresHorizontalScrollFallback).toBe(false);
    expect(result.items.map((item) => item.width)).toEqual([160, 160, 160, 160]);
  });

  it("keeps every tab at the clickable minimum at the exact fit boundary", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 404,
      tabLabelWidths: [98, 98, 98, 98],
      metrics,
      compact: false,
    });

    expect(result.closeButtonPolicy).toBe("all");
    expect(result.requiresHorizontalScrollFallback).toBe(false);
    expect(result.items.map((item) => item.width)).toEqual([64, 64, 64, 64]);
    expect(result.items.every((item) => item.showLabel)).toBe(true);
  });

  it("scrolls at natural widths rather than shrinking below the clickable minimum", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 403,
      tabLabelWidths: [98, 98, 98, 98],
      metrics,
      compact: false,
    });

    expect(result.closeButtonPolicy).toBe("all");
    expect(result.requiresHorizontalScrollFallback).toBe(true);
    expect(result.items.map((item) => item.width)).toEqual([132, 132, 132, 132]);
    expect(result.items.every((item) => item.showLabel)).toBe(true);
  });

  it("keeps natural widths and no inline close on compact layouts while the tabs fit", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 600,
      tabLabelWidths: [56, 70, 49],
      metrics,
      compact: true,
    });

    expect(result.closeButtonPolicy).toBe("none");
    expect(result.requiresHorizontalScrollFallback).toBe(false);
    expect(result.items.map((item) => item.width)).toEqual([90, 104, 83]);
  });

  it("scrolls compact layouts as soon as natural widths overflow instead of squeezing labels", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 460,
      tabLabelWidths: [168, 84, 56],
      metrics,
      compact: true,
    });

    expect(result.requiresHorizontalScrollFallback).toBe(true);
    expect(result.items.map((item) => item.width)).toEqual([160, 118, 90]);
    expect(result.items.every((item) => item.showLabel)).toBe(true);
  });

  it("returns empty layout details when there are no tabs", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 1200,
      tabLabelWidths: [],
      metrics,
      compact: false,
    });

    expect(result.closeButtonPolicy).toBe("all");
    expect(result.requiresHorizontalScrollFallback).toBe(false);
    expect(result.items).toEqual([]);
  });

  it("uses rendered label width rather than character count", () => {
    const result = computeWorkspaceTabLayout({
      viewportWidth: 1200,
      tabLabelWidths: [68, 104],
      metrics,
      compact: false,
    });

    expect(result.items.map((item) => item.width)).toEqual([102, 138]);
  });
});

describe("retainWorkspaceTabMeasuredWidth", () => {
  it("retains the last usable width while a retained panel is hidden", () => {
    expect(retainWorkspaceTabMeasuredWidth(720, 0)).toBe(720);
  });

  it("accepts the next usable layout width", () => {
    expect(retainWorkspaceTabMeasuredWidth(720, 640)).toBe(640);
  });
});

describe("Explorer toggle ownership", () => {
  const toggleProps = {
    onPress: () => {},
    label: "Close Explorer sidebar",
    tooltipLabel: "Toggle Explorer sidebar",
    tooltipKeys: [],
    accessibilityState: { expanded: true },
  };

  it("keeps only the header toggle when window controls do not obstruct it", () => {
    expect(WorkspaceHeaderExplorerToggle({ ...toggleProps, owner: "header" })).not.toBeNull();
    expect(WorkspaceExplorerSidebarToggle({ ...toggleProps, owner: "header" })).toBeNull();
  });

  it("keeps the dock toggle for window-owned and compact overlay chrome", () => {
    for (const owner of ["window", "mobile"] as const) {
      expect(WorkspaceHeaderExplorerToggle({ ...toggleProps, owner })).toBeNull();
      expect(WorkspaceExplorerSidebarToggle({ ...toggleProps, owner })).not.toBeNull();
    }
  });

  it("closes the compact overlay with the same X as the compact agent list", () => {
    expect(WorkspaceExplorerSidebarToggle({ ...toggleProps, owner: "mobile" })?.type).toBe(
      SidebarCloseButton,
    );
    expect(WorkspaceExplorerSidebarToggle({ ...toggleProps, owner: "window" })?.type).not.toBe(
      SidebarCloseButton,
    );
  });
});

describe("resolveWorkspaceTabChipBackdrop", () => {
  const themes = { light: lightTheme, dark: darkTheme, pureBlack: darkPureBlackTheme };
  const rails = {
    sidebar: "surfaceSidebar",
    surface: "surface0",
  } as const;

  it("paints the active chip in a colour the rail does not already use, in every theme", () => {
    for (const [, theme] of Object.entries(themes)) {
      for (const [rail, resting] of Object.entries(rails) as Array<
        [keyof typeof rails, (typeof rails)[keyof typeof rails]]
      >) {
        const active = resolveWorkspaceTabChipBackdrop({
          rail,
          isActiveFocused: true,
          isFilled: true,
        });
        const filled = resolveWorkspaceTabChipBackdrop({
          rail,
          isActiveFocused: false,
          isFilled: true,
        });
        expect(theme.colors[active]).not.toBe(theme.colors[resting]);
        expect(theme.colors[filled]).not.toBe(theme.colors[resting]);
        expect(theme.colors[active]).not.toBe(theme.colors[filled]);
      }
    }
  });

  it("rests on the rail surface when the chip is neither active nor hovered", () => {
    expect(
      resolveWorkspaceTabChipBackdrop({ rail: "sidebar", isActiveFocused: false, isFilled: false }),
    ).toBe("surfaceSidebar");
    expect(
      resolveWorkspaceTabChipBackdrop({ rail: "surface", isActiveFocused: false, isFilled: false }),
    ).toBe("surface0");
  });
});

describe("selected workspace tab visibility", () => {
  const geometry = {
    offset: 0,
    viewportWidth: 300,
    contentWidth: 800,
    tabStart: 440,
    tabWidth: 140,
  };

  it("reveals an offscreen selected or newly opened tab", () => {
    expect(resolveWorkspaceTabScrollOffset(geometry)).toBe(280);
  });

  it("keeps a fully visible selection at the user's current offset", () => {
    expect(resolveWorkspaceTabScrollOffset({ ...geometry, offset: 400 })).toBe(400);
  });

  it("reveals an earlier tab after selecting it", () => {
    expect(resolveWorkspaceTabScrollOffset({ ...geometry, offset: 500 })).toBe(440);
  });

  it("updates visibility after rotation and clamps after closing tabs", () => {
    expect(resolveWorkspaceTabScrollOffset({ ...geometry, viewportWidth: 160 })).toBe(420);
    expect(resolveWorkspaceTabScrollOffset({ ...geometry, offset: 500, contentWidth: 600 })).toBe(
      300,
    );
  });

  it("waits for usable native measurements", () => {
    expect(resolveWorkspaceTabScrollOffset({ ...geometry, viewportWidth: 0 })).toBe(0);
  });
});
