import { describe, expect, it } from "vitest";
import { workspaceTrailingActionsRevealWidth } from "./workspace-kebab-geometry";

/** The archive button's 18px box and its 8px gap before the kebab. */
const ARCHIVE_BUTTON_FOOTPRINT = 18 + 8;

describe("workspaceTrailingActionsRevealWidth", () => {
  it("reserves the pointer kebab's flow width: its box less the optical pull", () => {
    expect(
      workspaceTrailingActionsRevealWidth({ touchSizing: false, archiveButtonFootprint: 0 }),
    ).toBe(18 - 7);
  });

  it("reserves the touch kebab's larger tap target, less its larger optical pull", () => {
    expect(
      workspaceTrailingActionsRevealWidth({ touchSizing: true, archiveButtonFootprint: 0 }),
    ).toBe(32 - 14);
  });

  it("adds the archive button and its gap left of the kebab", () => {
    expect(
      workspaceTrailingActionsRevealWidth({
        touchSizing: false,
        archiveButtonFootprint: ARCHIVE_BUTTON_FOOTPRINT,
      }),
    ).toBe(18 + 8 + 18 - 7);
  });

  it("adds the archive button beside a touch-sized kebab on touch-screen desktops", () => {
    expect(
      workspaceTrailingActionsRevealWidth({
        touchSizing: true,
        archiveButtonFootprint: ARCHIVE_BUTTON_FOOTPRINT,
      }),
    ).toBe(18 + 8 + 32 - 14);
  });
});
