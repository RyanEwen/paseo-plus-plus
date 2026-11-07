import { describe, expect, it } from "vitest";
import { projectBlockActivityEqual } from "./project-block-activity";

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
