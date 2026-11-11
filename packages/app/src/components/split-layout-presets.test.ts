import { describe, expect, it } from "vitest";
import { applySplitLayoutPreset, canApplySplitLayoutPreset } from "./split-layout-presets";

describe("split layout presets", () => {
  it("changes only the adjacent pair and preserves its total", () => {
    const result = applySplitLayoutPreset([0.2, 0.5, 0.3], 1, 0.6);
    expect(result[0]).toBe(0.2);
    expect(result[1]).toBeCloseTo(0.48);
    expect(result[2]).toBeCloseTo(0.32);
  });
  it("disables ratios that cannot fit the normal pane minimum", () => {
    expect(canApplySplitLayoutPreset([0.8, 0.1, 0.1], 1, 0.6)).toBe(false);
    expect(canApplySplitLayoutPreset([0.8, 0.1, 0.1], 1, 0.5)).toBe(true);
    expect(canApplySplitLayoutPreset([0.5, 0.5], 0, 0.7)).toBe(true);
  });
  it("rejects missing dividers and invalid fractions", () => {
    expect(applySplitLayoutPreset([0.5, 0.5], 1, 0.6)).toEqual([0.5, 0.5]);
    expect(applySplitLayoutPreset([0.5, 0.5], 0, NaN)).toEqual([0.5, 0.5]);
    expect(canApplySplitLayoutPreset([0.5, 0.5], 0, 1)).toBe(false);
  });
});
