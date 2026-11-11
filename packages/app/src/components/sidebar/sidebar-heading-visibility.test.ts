import { describe, expect, it } from "vitest";
import {
  shouldShowSidebarHeading,
  type SidebarHeadingVisibilityInput,
} from "./sidebar-heading-visibility";

/** A genuinely empty project-mode sidebar: no projects, pins, empty groups or filters. */
const emptyProjectMode: SidebarHeadingVisibilityInput = {
  groupMode: "project",
  unpinnedProjectCount: 0,
  pinnedWorkspaceCount: 0,
  emptyProjectCount: 0,
  groupsEmptyProjects: false,
  hasActiveHostFilter: false,
  hasActiveProjectFilter: false,
  sidebarFilterEmpty: false,
};

describe("shouldShowSidebarHeading", () => {
  it("hides the heading over a genuinely empty project-mode sidebar", () => {
    expect(shouldShowSidebarHeading(emptyProjectMode)).toBe(false);
  });

  it("shows the heading when project mode lists anything below or above it", () => {
    expect(shouldShowSidebarHeading({ ...emptyProjectMode, unpinnedProjectCount: 1 })).toBe(true);
    expect(shouldShowSidebarHeading({ ...emptyProjectMode, pinnedWorkspaceCount: 1 })).toBe(true);
    expect(
      shouldShowSidebarHeading({
        ...emptyProjectMode,
        emptyProjectCount: 1,
        groupsEmptyProjects: true,
      }),
    ).toBe(true);
  });

  it("does not count empty projects that project mode is not grouping", () => {
    expect(shouldShowSidebarHeading({ ...emptyProjectMode, emptyProjectCount: 1 })).toBe(false);
  });

  it("keeps the heading while a filter is what emptied project mode", () => {
    expect(shouldShowSidebarHeading({ ...emptyProjectMode, hasActiveHostFilter: true })).toBe(true);
    expect(shouldShowSidebarHeading({ ...emptyProjectMode, hasActiveProjectFilter: true })).toBe(
      true,
    );
    expect(shouldShowSidebarHeading({ ...emptyProjectMode, sidebarFilterEmpty: true })).toBe(true);
  });

  it("always shows the heading in status mode", () => {
    expect(shouldShowSidebarHeading({ ...emptyProjectMode, groupMode: "status" })).toBe(true);
  });
});
