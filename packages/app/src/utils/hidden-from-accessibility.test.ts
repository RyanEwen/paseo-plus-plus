import { describe, expect, it } from "vitest";
import { hiddenFromAccessibilityProps } from "./hidden-from-accessibility";

describe("hiddenFromAccessibilityProps", () => {
  it("hides a view and its children on every platform", () => {
    expect(hiddenFromAccessibilityProps(true)).toEqual({
      accessibilityElementsHidden: true,
      importantForAccessibility: "no-hide-descendants",
      "aria-hidden": true,
    });
  });

  it("leaves a view in the accessibility tree", () => {
    expect(hiddenFromAccessibilityProps(false)).toEqual({
      accessibilityElementsHidden: false,
      importantForAccessibility: "auto",
      "aria-hidden": false,
    });
  });
});
