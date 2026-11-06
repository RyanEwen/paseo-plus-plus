import { describe, expect, it } from "vitest";
import {
  canApplyExplorerSidebarDockSizes,
  resolveExplorerSidebarDockSizes,
  resolveExplorerSidebarWidth,
} from "@/components/explorer-sidebar-layout";

describe("Explorer sidebar layout", () => {
  it("accepts only ratios that preserve both dock and main pixel minimums", () => {
    expect(canApplyExplorerSidebarDockSizes({ sizes: [0.7, 0.3], containerWidth: 800 })).toBe(true);
    expect(canApplyExplorerSidebarDockSizes({ sizes: [0.7, 0.3], containerWidth: 799 })).toBe(
      false,
    );
    expect(canApplyExplorerSidebarDockSizes({ sizes: [0.5, 0.5], containerWidth: 800 })).toBe(true);
    expect(canApplyExplorerSidebarDockSizes({ sizes: [0.3, 0.7], containerWidth: 1000 })).toBe(
      false,
    );
    expect(canApplyExplorerSidebarDockSizes({ sizes: [0.3, 0.7], containerWidth: 1600 })).toBe(
      true,
    );
  });

  it("leaves accepted preset widths unchanged through dock persistence and remeasurement", () => {
    const sizes = [0.6, 0.4];
    const containerWidth = 1000;
    expect(canApplyExplorerSidebarDockSizes({ sizes, containerWidth })).toBe(true);
    const persistedWidth = resolveExplorerSidebarWidth({
      requestedWidth: sizes[1] * containerWidth,
      containerWidth,
    });
    expect(persistedWidth).toBe(400);
    expect(
      resolveExplorerSidebarDockSizes({ requestedWidth: persistedWidth, containerWidth }),
    ).toEqual(sizes);
  });

  it("does not offer presets before measurement or with invalid dimensions", () => {
    for (const containerWidth of [0, -1, NaN, Infinity]) {
      expect(canApplyExplorerSidebarDockSizes({ sizes: [0.5, 0.5], containerWidth })).toBe(false);
    }
    expect(canApplyExplorerSidebarDockSizes({ sizes: [], containerWidth: 1000 })).toBe(false);
  });
  it("keeps the sidebar width fixed when the workspace body changes size", () => {
    const narrow = resolveExplorerSidebarDockSizes({ requestedWidth: 320, containerWidth: 1200 });
    const wide = resolveExplorerSidebarDockSizes({ requestedWidth: 320, containerWidth: 1520 });

    expect(narrow[1] * 1200).toBeCloseTo(320);
    expect(wide[1] * 1520).toBeCloseTo(320);
  });

  it("has no fixed maximum while preserving room for the workspace body", () => {
    expect(resolveExplorerSidebarWidth({ requestedWidth: 100, containerWidth: 1200 })).toBe(240);
    expect(resolveExplorerSidebarWidth({ requestedWidth: 900, containerWidth: 1600 })).toBe(900);
    expect(resolveExplorerSidebarWidth({ requestedWidth: 900, containerWidth: 1200 })).toBe(800);
    expect(resolveExplorerSidebarWidth({ requestedWidth: 600, containerWidth: 750 })).toBe(350);
  });
});
