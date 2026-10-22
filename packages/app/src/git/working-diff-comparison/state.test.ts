import { createWorkingDiffComparisonStore } from "./index";
import { createInMemoryKeyValueStorage } from "@/hooks/use-settings/fakes";
import { describe, expect, it } from "vitest";
import {
  resolveWorkingDiffComparisonFromState,
  selectWorkingDiffComparisonInState,
  type WorkingDiffComparisonState,
  workingDiffComparisonKey,
} from "./state";

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
  it("restores the selected comparison after the app reloads", async () => {
    const storage = createInMemoryKeyValueStorage();
    const source = createWorkingDiffComparisonStore(storage);
    await source.persist.rehydrate();
    source.getState().select({ ...checkout, comparison: "base", isDirty: false });
    const restored = createWorkingDiffComparisonStore(storage);
    await restored.persist.rehydrate();
    expect(
      resolveWorkingDiffComparisonFromState(restored.getState(), {
        ...checkout,
        policy: undefined,
        isDirty: true,
      }),
    ).toBe("base");
  });

  it("defaults to uncommitted regardless of dirtiness unless a different default is configured", () => {
    expect(
      resolveWorkingDiffComparisonFromState(emptyState(), {
        ...checkout,
        policy: undefined,
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
        policy: undefined,
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
        policy: undefined,
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
