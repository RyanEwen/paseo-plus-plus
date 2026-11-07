import { describe, expect, it } from "vitest";
import {
  resolveWorkingDiffComparisonFromState,
  selectWorkingDiffComparisonInState,
  type WorkingDiffComparisonState,
  workingDiffComparisonKey,
  workingDiffComparisonPolicy,
} from "./state";
import { DEFAULT_CLIENT_SETTINGS } from "@/hooks/use-settings/storage";

const defaultPolicy = workingDiffComparisonPolicy(DEFAULT_CLIENT_SETTINGS);

const checkout = {
  serverId: "server-1",
  workspaceId: "workspace-1",
  cwd: "/repo",
  policy: { defaultComparison: "uncommitted" as const, autoSwitch: true },
};

function emptyState(): WorkingDiffComparisonState {
  return { overrides: {} };
}

describe("working diff comparison", () => {
  it("defaults to uncommitted regardless of dirtiness unless a different default is configured", () => {
    expect(
      resolveWorkingDiffComparisonFromState(emptyState(), {
        ...checkout,
        policy: defaultPolicy,
        isDirty: false,
      }),
    ).toBe("uncommitted");
    expect(
      resolveWorkingDiffComparisonFromState(emptyState(), {
        ...checkout,
        policy: { defaultComparison: "base", autoSwitch: false },
        isDirty: true,
      }),
    ).toBe("base");
  });

  it("keeps manual comparisons across dirty transitions when automatic switching is off", () => {
    const state = selectWorkingDiffComparisonInState(emptyState(), {
      ...checkout,
      comparison: "uncommitted",
      isDirty: true,
    });
    expect(
      resolveWorkingDiffComparisonFromState(state, {
        ...checkout,
        policy: defaultPolicy,
        isDirty: false,
      }),
    ).toBe("uncommitted");
    const committed = selectWorkingDiffComparisonInState(state, {
      ...checkout,
      comparison: "base",
      isDirty: false,
    });
    expect(
      resolveWorkingDiffComparisonFromState(committed, {
        ...checkout,
        policy: defaultPolicy,
        isDirty: true,
      }),
    ).toBe("base");
  });

  it("scopes selection to the workspace checkout rather than a panel", () => {
    expect(workingDiffComparisonKey(checkout)).toBe(
      "working-diff:server=server-1:workspace=workspace-1",
    );
    expect(workingDiffComparisonKey({ ...checkout, workspaceId: "workspace-2" })).not.toBe(
      workingDiffComparisonKey(checkout),
    );
    expect(workingDiffComparisonKey({ ...checkout, workspaceId: null, cwd: "/repo/" })).toBe(
      "working-diff:server=server-1:cwd=%2Frepo",
    );
  });

  it.each([true, false])(
    "uses a configured All changes default when checkout dirtiness is %s",
    (isDirty) => {
      const status = {
        ...checkout,
        isDirty,
        policy: { defaultComparison: "all" as const, autoSwitch: false },
      };
      expect(resolveWorkingDiffComparisonFromState(emptyState(), status)).toBe("all");
    },
  );

  it.each(["all", "base", "uncommitted"] as const)(
    "keeps the selected %s comparison",
    (comparison) => {
      const status = {
        ...checkout,
        isDirty: false,
        policy: { defaultComparison: "all" as const, autoSwitch: false },
      };
      const selected = selectWorkingDiffComparisonInState(emptyState(), {
        ...status,
        comparison,
      });
      expect(resolveWorkingDiffComparisonFromState(selected, status)).toBe(comparison);
      expect(
        resolveWorkingDiffComparisonFromState(selected, { ...status, workspaceId: "other" }),
      ).toBe("all");
    },
  );
});
