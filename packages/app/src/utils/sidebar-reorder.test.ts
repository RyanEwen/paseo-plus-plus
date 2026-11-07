import { describe, expect, it } from "vitest";
import {
  applyStoredOrdering,
  computeSidebarOrderUpdates,
} from "@/hooks/sidebar-workspaces-view-model";
import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";

import {
  hasVisibleOrderChanged,
  mergeWithRemainder,
  moveProjectInFullOrder,
  canCommitSidebarReorder,
  sidebarReorderContext,
  sidebarReorderSort,
  resolveProjectWorkspaceReorder,
} from "./sidebar-reorder";

describe("hasVisibleOrderChanged", () => {
  it("returns false when visible order is unchanged", () => {
    expect(
      hasVisibleOrderChanged({
        currentOrder: ["a", "b", "c", "d"],
        reorderedVisibleKeys: ["a", "b", "c"],
      }),
    ).toBe(false);
  });

  it("returns true when visible items are reordered", () => {
    expect(
      hasVisibleOrderChanged({
        currentOrder: ["a", "b", "c", "d"],
        reorderedVisibleKeys: ["b", "a", "c"],
      }),
    ).toBe(true);
  });

  it("returns true when a visible key is missing from current order", () => {
    expect(
      hasVisibleOrderChanged({
        currentOrder: ["a", "b"],
        reorderedVisibleKeys: ["a", "c"],
      }),
    ).toBe(true);
  });
});

describe("mergeWithRemainder", () => {
  it("appends non-visible stored keys after reordered visible keys", () => {
    expect(
      mergeWithRemainder({
        currentOrder: ["a", "x", "b", "y"],
        reorderedVisibleKeys: ["b", "a"],
      }),
    ).toEqual(["b", "a", "x", "y"]);
  });

  it("keeps unknown current keys when no visible keys are reordered", () => {
    expect(
      mergeWithRemainder({
        currentOrder: ["stale", "hidden"],
        reorderedVisibleKeys: [],
      }),
    ).toEqual(["stale", "hidden"]);
  });
});

describe("project pin reordering", () => {
  const input = {
    currentVisibleKeys: ["srv:pin1", "srv:pin2", "srv:a", "srv:b"],
    projectPinnedKeys: new Set(["srv:pin1", "srv:pin2"]),
    storedWorkspaceOrder: ["srv:a", "srv:hidden", "srv:pin1", "srv:b", "srv:pin2"],
  };
  it("does not rewrite saved workspace order when pins move within their partition", () => {
    const result = resolveProjectWorkspaceReorder({
      ...input,
      reorderedVisibleKeys: ["srv:pin2", "srv:pin1", "srv:a", "srv:b"],
      move: { activeKey: "srv:pin1", overKey: "srv:pin2", from: 0, to: 1 },
    });
    expect(result).toEqual({ pinOrder: ["srv:pin2", "srv:pin1"], workspaceOrder: null });
  });
  it("reorders ordinary siblings while retaining hidden and pinned saved keys", () => {
    const result = resolveProjectWorkspaceReorder({
      ...input,
      reorderedVisibleKeys: ["srv:pin1", "srv:pin2", "srv:b", "srv:a"],
      move: { activeKey: "srv:a", overKey: "srv:b", from: 2, to: 3 },
    });
    // An ordinary drag must not freeze the untouched pins into a manual pin order.
    expect(result).toEqual({
      pinOrder: null,
      workspaceOrder: ["srv:hidden", "srv:pin1", "srv:b", "srv:a", "srv:pin2"],
    });
    expect(input.storedWorkspaceOrder).toEqual([
      "srv:a",
      "srv:hidden",
      "srv:pin1",
      "srv:b",
      "srv:pin2",
    ]);
  });
});

it("treats saved project pins as ordinary rows when project pinning is disabled", () => {
  const storedWorkspaceOrder = ["srv:ordinary", "srv:pin", "srv:hidden"];
  const result = resolveProjectWorkspaceReorder({
    currentVisibleKeys: ["srv:ordinary", "srv:pin"],
    reorderedVisibleKeys: ["srv:pin", "srv:ordinary"],
    projectPinnedKeys: new Set(),
    storedWorkspaceOrder,
    move: { activeKey: "srv:ordinary", overKey: "srv:pin", from: 0, to: 1 },
  });
  expect(result).toEqual({
    pinOrder: null,
    workspaceOrder: ["srv:pin", "srv:ordinary", "srv:hidden"],
  });
  expect(storedWorkspaceOrder).toEqual(["srv:ordinary", "srv:pin", "srv:hidden"]);
});

describe("anchored workspace move through a limited family window", () => {
  const canonical = Array.from({ length: 12 }, (_, index) => `srv:${index}`);
  const visible = [...canonical.slice(0, 7), canonical[9]!];
  const input = {
    currentVisibleKeys: canonical,
    projectPinnedKeys: new Set<string>(),
    storedWorkspaceOrder: canonical,
  };
  it("swaps the dragged first two rows without promoting passive overflow over hidden siblings", () => {
    const result = resolveProjectWorkspaceReorder({
      ...input,
      reorderedVisibleKeys: [canonical[1]!, canonical[0]!, ...canonical.slice(2, 7), canonical[9]!],
      move: { activeKey: "srv:0", overKey: "srv:1", from: 0, to: 1 },
    });
    expect(result).toEqual({
      pinOrder: null,
      workspaceOrder: [canonical[1], canonical[0], ...canonical.slice(2)],
    });
    expect(result.workspaceOrder?.filter((key) => key !== "srv:0")).toEqual(
      canonical.filter((key) => key !== "srv:0"),
    );
    expect(input.storedWorkspaceOrder).toEqual(canonical);
  });
  it("moves an actual dragged overflow row backward before its exact visible anchor", () => {
    const result = resolveProjectWorkspaceReorder({
      ...input,
      reorderedVisibleKeys: [canonical[0]!, canonical[9]!, ...canonical.slice(1, 7)],
      move: { activeKey: "srv:9", overKey: "srv:1", from: 7, to: 1 },
    });
    expect(result.workspaceOrder).toEqual([
      canonical[0],
      canonical[9],
      ...canonical.slice(1, 9),
      ...canonical.slice(10),
    ]);
  });
  it("moves forward after the exact overflow anchor without pulling hidden rows along", () => {
    const result = resolveProjectWorkspaceReorder({
      ...input,
      reorderedVisibleKeys: [...canonical.slice(1, 7), canonical[9]!, canonical[0]!],
      move: { activeKey: "srv:0", overKey: "srv:9", from: 0, to: 7 },
    });
    expect(result.workspaceOrder).toEqual([
      ...canonical.slice(1, 10),
      canonical[0],
      ...canonical.slice(10),
    ]);
  });
  it.each([
    {
      known: ["srv:A", "srv:B", "srv:C"],
      saved: ["srv:B", "srv:C"],
      result: ["srv:A", "srv:C", "srv:B"],
      move: { activeKey: "srv:B", overKey: "srv:C", from: 1, to: 2 },
    },
    {
      known: ["srv:A", "srv:B", "srv:C", "srv:D"],
      saved: ["srv:A", "srv:C", "srv:D"],
      result: ["srv:A", "srv:B", "srv:D", "srv:C"],
      move: { activeKey: "srv:C", overKey: "srv:D", from: 2, to: 3 },
    },
  ])(
    "rejects incomplete prefix/interleaved passive ranks without either write: %j",
    ({ known, saved, result, move }) => {
      expect(
        resolveProjectWorkspaceReorder({
          currentVisibleKeys: known,
          storedWorkspaceOrder: saved,
          reorderedVisibleKeys: result,
          projectPinnedKeys: new Set(),
          move,
        }),
      ).toEqual({ pinOrder: null, workspaceOrder: null });
    },
  );
  it("admits a fresh ordinary gesture after the existing owner reconciles missing ranks", () => {
    const known = ["srv:A", "srv:B", "srv:C"];
    const saved = ["unknown", "srv:B", "offline", "srv:C"];
    const project: SidebarProjectEntry = {
      viewKey: "project",
      projectName: "Project",
      projectKind: "git",
      iconWorkingDir: "/repo",
      hosts: [],
      workspaces: known.map((workspaceKey) => ({
        workspaceKey,
        workspaceId: workspaceKey.slice(4),
        serverId: "srv",
        projectViewKey: "project",
        projectName: "Project",
        projectKind: "git",
        workspaceKind: "worktree",
        name: workspaceKey,
      })),
    };
    const updates = computeSidebarOrderUpdates({
      projects: [project],
      persistedProjectOrder: [project.viewKey],
      getWorkspaceOrder: () => saved,
    });
    expect(updates.workspaceOrders).toEqual([
      {
        projectViewKey: "project",
        order: ["srv:A", "unknown", "srv:B", "offline", "srv:C"],
      },
    ]);
    const reconciled = updates.workspaceOrders[0]?.order;
    if (!reconciled) throw new Error("Existing owner did not reconcile missing workspace rank");
    const current = applyStoredOrdering({
      items: known,
      storedOrder: reconciled,
      getKey: (key) => key,
    });
    expect(current).toEqual(known);
    const result = resolveProjectWorkspaceReorder({
      currentVisibleKeys: current,
      storedWorkspaceOrder: reconciled,
      reorderedVisibleKeys: ["srv:A", "srv:C", "srv:B"],
      projectPinnedKeys: new Set(),
      move: { activeKey: "srv:B", overKey: "srv:C", from: 1, to: 2 },
    });
    expect(result).toEqual({
      pinOrder: null,
      workspaceOrder: ["srv:A", "unknown", "offline", "srv:C", "srv:B"],
    });
    expect(saved).toEqual(["unknown", "srv:B", "offline", "srv:C"]);
  });
  it("keeps a valid automatic-sort pin drag independent of absent ordinary ranks", () => {
    expect(
      resolveProjectWorkspaceReorder({
        currentVisibleKeys: ["srv:pin1", "srv:pin2", "srv:A"],
        storedWorkspaceOrder: [],
        reorderedVisibleKeys: ["srv:pin2", "srv:pin1", "srv:A"],
        projectPinnedKeys: new Set(["srv:pin1", "srv:pin2"]),
        move: { activeKey: "srv:pin1", overKey: "srv:pin2", from: 0, to: 1 },
      }),
    ).toEqual({ pinOrder: ["srv:pin2", "srv:pin1"], workspaceOrder: null });
  });
  it.each([
    { activeKey: "absent", overKey: "srv:1", from: 0, to: 1 },
    { activeKey: "srv:0", overKey: "absent", from: 0, to: 1 },
    { activeKey: "srv:0", overKey: "srv:9", from: 0, to: 1 },
    { activeKey: "srv:1", overKey: "srv:0", from: 0, to: 1 },
    { activeKey: "srv:0", overKey: "srv:1", from: -1, to: 1 },
    { activeKey: "srv:0", overKey: "srv:1", from: 0, to: 1.5 },
  ])("rejects an absent, stale or invalid move without writing either order: %j", (move) => {
    expect(
      resolveProjectWorkspaceReorder({
        ...input,
        reorderedVisibleKeys: [canonical[1]!, canonical[0]!, ...visible.slice(2)],
        move,
      }),
    ).toEqual({ pinOrder: null, workspaceOrder: null });
  });
  it("rejects an anchor from outside the actual sibling list even when present in the project", () => {
    expect(
      resolveProjectWorkspaceReorder({
        ...input,
        reorderedVisibleKeys: ["srv:1", "srv:0"],
        move: { activeKey: "srv:0", overKey: "srv:9", from: 0, to: 1 },
      }),
    ).toEqual({ pinOrder: null, workspaceOrder: null });
  });
  it("rejects a cross-pin-partition drag without updating pins or ordinary siblings", () => {
    expect(
      resolveProjectWorkspaceReorder({
        ...input,
        projectPinnedKeys: new Set(["srv:0"]),
        reorderedVisibleKeys: ["srv:1", "srv:0"],
        move: { activeKey: "srv:0", overKey: "srv:1", from: 0, to: 1 },
      }),
    ).toEqual({ pinOrder: null, workspaceOrder: null });
  });
  it("rejects a drop result that moves an additional passive sibling", () => {
    expect(
      resolveProjectWorkspaceReorder({
        ...input,
        reorderedVisibleKeys: ["srv:1", "srv:0", "srv:9", ...canonical.slice(2, 7)],
        move: { activeKey: "srv:0", overKey: "srv:1", from: 0, to: 1 },
      }),
    ).toEqual({ pinOrder: null, workspaceOrder: null });
  });
});

describe("anchored filtered project move", () => {
  const currentOrder = ["unknown", "host:a", "offline:x", "host:b", "hidden:y", "host:c"];
  it("moves A after the same B anchor when All is restored", () => {
    const next = moveProjectInFullOrder({
      currentOrder,
      knownProjectKeys: [],
      move: { activeKey: "host:a", overKey: "host:b", from: 0, to: 1 },
    });
    expect(next).toEqual(["unknown", "offline:x", "host:b", "host:a", "hidden:y", "host:c"]);
    expect(next?.filter((key) => key !== "host:a")).toEqual(
      currentOrder.filter((key) => key !== "host:a"),
    );
  });
  it("moves B before A for the opposite active item in the same visible swap", () => {
    expect(
      moveProjectInFullOrder({
        currentOrder,
        knownProjectKeys: [],
        move: { activeKey: "host:b", overKey: "host:a", from: 1, to: 0 },
      }),
    ).toEqual(["unknown", "host:b", "host:a", "offline:x", "hidden:y", "host:c"]);
  });
  it("materializes missing cached siblings without discarding saved unavailable keys", () => {
    expect(
      moveProjectInFullOrder({
        currentOrder: ["unknown", "host:a"],
        knownProjectKeys: ["host:a", "offline:x", "host:b"],
        move: { activeKey: "host:b", overKey: "host:a", from: 1, to: 0 },
      }),
    ).toEqual(["unknown", "host:b", "host:a", "offline:x"]);
  });
  it("does not persist a cancelled, unchanged or no-longer-known target", () => {
    expect(
      moveProjectInFullOrder({
        currentOrder,
        knownProjectKeys: [],
        move: { activeKey: "host:a", overKey: "host:a", from: 0, to: 0 },
      }),
    ).toBeNull();
    expect(
      moveProjectInFullOrder({
        currentOrder,
        knownProjectKeys: [],
        move: { activeKey: "missing", overKey: "host:a", from: 1, to: 0 },
      }),
    ).toBeNull();
  });
});

describe("Custom-only sidebar reorder domains", () => {
  const view = {
    groupMode: "project" as const,
    sortMode: "custom" as const,
    workspaceSortMode: "custom" as const,
    workspaceSort: "manual" as const,
    emptyProjectSortMode: "project" as const,
    hostFilters: [],
    projectFilters: [],
    labelFilter: { labels: [] },
    showBackground: false,
    projectVisibility: "all" as const,
    groupEmptyProjects: true,
  };
  it("uses the owning project's sort, Status empty-project sort, and workspace sort independently", () => {
    expect(sidebarReorderSort(view, "project")).toBe("custom");
    expect(sidebarReorderSort({ ...view, groupMode: "status" }, "project")).toBe("project");
    expect(sidebarReorderSort({ ...view, workspaceSortMode: "name" }, "workspace")).toBe("name");
  });
  it.each(["project", "name", "status"])(
    "rejects ordinary drops for %s without changing sort",
    (sort) => {
      expect(
        canCommitSidebarReorder({ startedContext: "same", currentContext: "same", sort }),
      ).toBe(false);
      expect(
        canCommitSidebarReorder({
          startedContext: "same",
          currentContext: "same",
          sort,
          manualPins: true,
        }),
      ).toBe(true);
    },
  );
  it("rejects stale grouping/filter contexts even for manual pins", () => {
    const startedContext = sidebarReorderContext(view, "project");
    const currentContext = sidebarReorderContext({ ...view, groupMode: "status" }, "project");
    expect(
      canCommitSidebarReorder({ startedContext, currentContext, sort: "custom", manualPins: true }),
    ).toBe(false);
    expect(sidebarReorderContext({ ...view, projectFilters: ["other"] }, "project")).not.toBe(
      startedContext,
    );
    expect(
      canCommitSidebarReorder({
        startedContext: null,
        currentContext: startedContext,
        sort: "custom",
      }),
    ).toBe(false);
  });
});
