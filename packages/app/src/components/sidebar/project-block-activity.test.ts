import { describe, expect, it } from "vitest";
import { getProjectActivity, projectBlockActivityEqual } from "./project-block-activity";

describe("projectBlockActivityEqual", () => {
  it("re-renders a project block when a reconnected host makes its aggregate known", () => {
    expect(
      projectBlockActivityEqual(
        { aggregateStatusBucket: null, workingWorkspaceCount: 0 },
        { aggregateStatusBucket: "running", workingWorkspaceCount: 0 },
      ),
    ).toBe(false);
  });

  it("re-renders a project block when only its working count changes", () => {
    expect(
      projectBlockActivityEqual(
        { aggregateStatusBucket: "running", workingWorkspaceCount: 1 },
        { aggregateStatusBucket: "running", workingWorkspaceCount: 2 },
      ),
    ).toBe(false);
  });

  it("keeps a project block memoized while its activity is unchanged", () => {
    expect(
      projectBlockActivityEqual(
        { aggregateStatusBucket: "attention", workingWorkspaceCount: 1 },
        { aggregateStatusBucket: "attention", workingWorkspaceCount: 1 },
      ),
    ).toBe(true);
  });
});

describe("getProjectActivity", () => {
  it("shows no activity for a project missing from the summary", () => {
    expect(getProjectActivity(new Map(), "project")).toEqual({ bucket: null, workingCount: 0 });
  });

  it("returns the summarized activity for a known project", () => {
    const activity = { bucket: "running", workingCount: 2 } as const;
    expect(getProjectActivity(new Map([["project", activity]]), "project")).toBe(activity);
  });
});
