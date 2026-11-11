import { describe, expect, it } from "vitest";
import { projectTrailingActionsWidth } from "./project-trailing-actions";

describe("projectTrailingActionsWidth", () => {
  it("reserves both desktop actions and their gap, less the optical pull", () => {
    expect(
      projectTrailingActionsWidth({
        hasNewWorkspaceAction: true,
        hasKebab: true,
        touchSizing: false,
      }),
    ).toBe(24 + 2 + 24 - 6);
  });

  it("reserves the touch kebab's extra left overhang", () => {
    expect(
      projectTrailingActionsWidth({
        hasNewWorkspaceAction: true,
        hasKebab: true,
        touchSizing: true,
      }),
    ).toBe(24 + 2 + 24 + 4 - 6);
  });

  it("reserves one action without a gap", () => {
    expect(
      projectTrailingActionsWidth({
        hasNewWorkspaceAction: true,
        hasKebab: false,
        touchSizing: true,
      }),
    ).toBe(24 - 6);
  });

  it("reserves nothing for a row without actions", () => {
    expect(
      projectTrailingActionsWidth({
        hasNewWorkspaceAction: false,
        hasKebab: false,
        touchSizing: false,
      }),
    ).toBe(0);
  });
});
