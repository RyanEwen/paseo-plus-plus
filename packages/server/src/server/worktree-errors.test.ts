import { describe, expect, it } from "vitest";
import { ExactBranchCheckedOutError, WorktreeNameConflictError } from "../utils/worktree.js";
import { toWorktreeWireError } from "./worktree-errors.js";

describe("toWorktreeWireError", () => {
  it("maps an exact checkout of an occupied branch to branch_already_checked_out", () => {
    expect(toWorktreeWireError(new ExactBranchCheckedOutError("feature/a"))).toEqual({
      code: "branch_already_checked_out",
      message: "Branch already checked out: feature/a. Select its existing worktree instead.",
    });
  });

  it.each(["directory", "branch", "stale-registration"] as const)(
    "maps a %s name conflict to worktree_name_conflict with its message",
    (kind) => {
      const error = new WorktreeNameConflictError({
        kind,
        conflictingName: "taken",
        message: `conflict: ${kind}`,
      });

      expect(toWorktreeWireError(error)).toEqual({
        code: "worktree_name_conflict",
        message: `conflict: ${kind}`,
      });
    },
  );
});
