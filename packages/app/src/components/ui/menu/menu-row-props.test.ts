import { describe, expect, it } from "vitest";
import { menuRowProps } from "./menu-row-props";

describe("menu row contract", () => {
  it("marks an enabled row as a navigable menu item outside the tab order", () => {
    expect(menuRowProps({ disabled: false })).toEqual({
      accessibilityRole: "menuitem",
      tabIndex: -1,
      dataSet: { menuItem: "true", menuDisabled: "false" },
    });
  });

  it("reports a disabled row to the engine and keeps a checkbox role", () => {
    expect(menuRowProps({ disabled: true, role: "checkbox" })).toEqual({
      accessibilityRole: "checkbox",
      tabIndex: -1,
      dataSet: { menuItem: "true", menuDisabled: "true" },
    });
  });
});
