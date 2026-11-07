import { describe, expect, it } from "vitest";
import { projectTrailingActionsWidth } from "./project-trailing-actions";

describe("projectTrailingActionsWidth", () => {
  it("reserves both desktop actions and their gap, less the optical pull", () => {
    expect(
      projectTrailingActionsWidth({ hasNewWorkspaceAction: true, hasKebab: true, compact: false }),
    ).toBe(24 + 2 + 24 - 6);
  });

  it("reserves the compact kebab's extra left overhang", () => {
    expect(
      projectTrailingActionsWidth({ hasNewWorkspaceAction: true, hasKebab: true, compact: true }),
    ).toBe(24 + 2 + 24 + 4 - 6);
  });

  it("reserves one action without a gap", () => {
    expect(
      projectTrailingActionsWidth({ hasNewWorkspaceAction: true, hasKebab: false, compact: true }),
    ).toBe(24 - 6);
  });

  it("reserves nothing for a row without actions", () => {
    expect(
      projectTrailingActionsWidth({ hasNewWorkspaceAction: false, hasKebab: false, compact: false }),
    ).toBe(0);
  });
});
