import { describe, expect, it } from "vitest";
import { workspaceKebabRevealWidth } from "./workspace-kebab-geometry";

describe("workspaceKebabRevealWidth", () => {
  it("reserves the desktop kebab's flow width: its box and leading gap, less the optical pull", () => {
    expect(workspaceKebabRevealWidth({ compact: false })).toBe(18 + 2 - 7);
  });

  it("reserves the compact kebab's larger tap target, less its larger optical pull", () => {
    expect(workspaceKebabRevealWidth({ compact: true })).toBe(32 + 2 - 14);
  });
});
