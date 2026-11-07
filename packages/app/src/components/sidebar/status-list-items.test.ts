import { describe, expect, test } from "vitest";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { SidebarWorkspaceGroup } from "./sidebar-labels";
import {
  buildStatusListItems,
  resolveStatusGroupReorder,
  statusListItemKey,
  type StatusListItem,
} from "./status-list-items";
import { limitSidebarWorkspaces } from "./workspace-limit";

function workspace(
  workspaceId: string,
  labels: string[],
  pinnedAt: string | null = null,
): SidebarWorkspaceEntry {
  return {
    workspaceKey: `host:${workspaceId}`,
    serverId: "host",
    workspaceId,
    projectViewKey: "project",
    projectName: "Project",
    projectRootPath: "/repo",
    workspaceDirectory: `/repo/${workspaceId}`,
    workspaceDirectoryLabel: workspaceId,
    projectKind: "git",
    workspaceKind: "worktree",
    name: workspaceId,
    title: null,
    pinnedAt,
    labels,
    currentBranch: "main",
    statusBucket: "done",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    prHint: null,
    archiveHasUncommittedChanges: null,
    archiveUnpushedCommitCount: null,
    scripts: [],
    hasRunningScripts: false,
  };
}

function group(key: "running" | "done", rows: SidebarWorkspaceEntry[]): SidebarWorkspaceGroup {
  return { key, label: key, leading: { kind: "status", bucket: key }, rows };
}

describe("stable status-list cells", () => {
  const first = workspace("first", []);
  const second = workspace("second", []);

  test("retains a workspace cell key when status moves it across group boundaries", () => {
    const before = buildStatusListItems({
      groups: [group("running", [first]), group("done", [second])],
      collapsedGroupKeys: new Set(),
      initialCount: 20,
      expandedGroupKeys: new Set(),
    });
    const after = buildStatusListItems({
      groups: [group("done", [second, first])],
      collapsedGroupKeys: new Set(),
      initialCount: 20,
      expandedGroupKeys: new Set(),
    });
    const find = (items: ReturnType<typeof buildStatusListItems>) =>
      items.find(
        (item) => item.kind === "workspace" && item.workspace.workspaceId === first.workspaceId,
      )!;
    expect(statusListItemKey(find(before))).toBe(statusListItemKey(find(after)));
    expect(after.filter((item) => item.kind === "workspace")).toHaveLength(2);
  });

  test("keeps per-group collapse and Show more limits independent", () => {
    const many = Array.from({ length: 21 }, (_, i) => workspace(String(i), []));
    const groups = [group("running", many), group("done", [second])];
    const items = buildStatusListItems({
      groups,
      collapsedGroupKeys: new Set(["done"]),
      initialCount: 20,
      expandedGroupKeys: new Set(),
    });
    expect(items.filter((item) => item.kind === "workspace")).toHaveLength(20);
    expect(items.find((item) => item.kind === "footer")).toMatchObject({
      groupKey: "running",
      expanded: false,
      canToggle: true,
    });
    const expanded = buildStatusListItems({
      groups,
      collapsedGroupKeys: new Set(["done"]),
      initialCount: 20,
      expandedGroupKeys: new Set(["running"]),
    });
    expect(expanded.filter((item) => item.kind === "workspace")).toHaveLength(21);
    expect(expanded.filter((item) => item.kind === "header")).toHaveLength(2);
  });

  test("gives collapsed and limited headers every workspace in their group for the heading count", () => {
    const many = Array.from({ length: 21 }, (_, i) => workspace(String(i), []));
    const items = buildStatusListItems({
      groups: [group("running", many), group("done", [first, second])],
      collapsedGroupKeys: new Set(["done"]),
      initialCount: 20,
      expandedGroupKeys: new Set(),
    });

    // The heading count reads the header's group, not the rows left visible below it.
    const headerCounts: Array<[string, number]> = [];
    for (const item of items) {
      if (item.kind === "header") {
        headerCounts.push([item.group.key, item.group.rows.length]);
      }
    }
    expect(headerCounts).toEqual([
      ["running", 21],
      ["done", 2],
    ]);
    expect(items.filter((item) => item.kind === "workspace")).toHaveLength(20);
  });
  test("uses the same configurable policy for status groups and project/pinned groups", () => {
    const rows = Array.from({ length: 25 }, (_, i) => workspace(String(i), []));
    const keys = rows.map((row) => row.workspaceKey);
    const expandedGroupKeys = new Set(["running"]);
    const collapsedGroupKeys = new Set(["done"]);
    for (const initialCount of [1, 7, 20, 25, 37, null]) {
      for (const expanded of [false, true]) {
        const projection = limitSidebarWorkspaces({ items: rows, initialCount, expanded });
        const items = buildStatusListItems({
          groups: [group("running", rows), group("done", rows)],
          initialCount,
          expandedGroupKeys: expanded ? expandedGroupKeys : new Set(),
          collapsedGroupKeys,
        });
        expect(
          items.filter((item) => item.kind === "workspace").map((item) => item.workspace),
        ).toEqual(projection.visibleItems);
        expect(items.find((item) => item.kind === "footer")).toMatchObject({
          canToggle: projection.canToggle,
          expanded,
        });
        expect(items.filter((item) => item.kind === "header")).toHaveLength(2);
        expect(rows.map((row) => row.workspaceKey)).toEqual(keys);
        expect(expandedGroupKeys).toEqual(new Set(["running"]));
        expect(collapsedGroupKeys).toEqual(new Set(["done"]));
      }
    }
    const all = buildStatusListItems({
      groups: [group("running", rows)],
      initialCount: null,
      expandedGroupKeys,
      collapsedGroupKeys,
    });
    const limited = buildStatusListItems({
      groups: [group("running", rows)],
      initialCount: 1,
      expandedGroupKeys,
      collapsedGroupKeys,
    });
    expect(all.filter((item) => item.kind === "workspace").map(statusListItemKey)).toEqual(
      limited.filter((item) => item.kind === "workspace").map(statusListItemKey),
    );
  });
});

describe("status-list age limits", () => {
  const now = Date.parse("2026-10-16T12:00:00Z");
  const cutoff = now - 86_400_000;
  const rows = [
    { ...workspace("old", []), statusEnteredAt: new Date(cutoff - 1) },
    { ...workspace("unknown", []), statusEnteredAt: null },
  ];

  test("keeps a footer for a status group whose every row is older than the limit", () => {
    const groups: SidebarWorkspaceGroup[] = [
      {
        key: "done",
        label: "Done",
        leading: { kind: "status", bucket: "done" },
        rows: [rows[0], rows[1]],
      },
    ];
    const input = {
      groups,
      collapsedGroupKeys: new Set<string>(),
      expandedGroupKeys: new Set<string>(),
      initialCount: null,
      updatedWithin: { days: 1, now },
    };
    expect(buildStatusListItems(input).map((item) => item.kind)).toEqual(["header", "footer"]);
    expect(buildStatusListItems(input).at(-1)).toMatchObject({ canToggle: true, expanded: false });
    expect(
      buildStatusListItems({ ...input, expandedGroupKeys: new Set(["done"]) }).filter(
        (item) => item.kind === "workspace",
      ),
    ).toHaveLength(2);
  });
});

describe("open workspace", () => {
  test("stays visible past its group's count limit until Show more", () => {
    const rows = ["one", "two", "three"].map((id) => workspace(id, []));
    const open = rows[2]!;
    const items = buildStatusListItems({
      groups: [group("done", rows)],
      collapsedGroupKeys: new Set(),
      expandedGroupKeys: new Set(),
      initialCount: 1,
      keep: (row) => row.workspaceKey === open.workspaceKey,
    });
    expect(items.filter((item) => item.kind === "workspace").map((item) => item.workspace)).toEqual(
      [rows[0], open],
    );
    expect(items.at(-1)).toMatchObject({ kind: "footer", canToggle: true, expanded: false });
  });
});

describe("status-list drops", () => {
  const [a, b, c] = ["a", "b", "c"].map((id) => workspace(id, []));
  const items = buildStatusListItems({
    groups: [group("running", [a!, b!]), group("done", [c!])],
    collapsedGroupKeys: new Set(),
    expandedGroupKeys: new Set(),
    initialCount: null,
  });

  /** Move one cell to another index, as the list reports a drop. */
  function moveCell(from: number, to: number): StatusListItem[] {
    const reordered = items.slice();
    const [cell] = reordered.splice(from, 1);
    reordered.splice(to, 0, cell!);
    return reordered;
  }

  test("returns the moved row's group order", () => {
    const reordered = moveCell(2, 1);
    const move = { activeKey: statusListItemKey(items[2]!), overKey: "", from: 2, to: 1 };
    expect(resolveStatusGroupReorder({ items, reordered, move })).toEqual([
      b!.workspaceKey,
      a!.workspaceKey,
    ]);
  });

  test("returns null when the group's order is unchanged", () => {
    const move = { activeKey: statusListItemKey(items[1]!), overKey: "", from: 1, to: 1 };
    expect(resolveStatusGroupReorder({ items, reordered: items.slice(), move })).toBeNull();
  });

  test("ignores a move whose active cell is a header or footer", () => {
    const move = { activeKey: statusListItemKey(items[0]!), overKey: "", from: 0, to: 0 };
    expect(resolveStatusGroupReorder({ items, reordered: items.slice(), move })).toBeNull();
  });
});

/** A status group for any bucket, so active-work families can be windowed like Done ones. */
function bucketGroup(
  key: SidebarWorkspaceEntry["statusBucket"],
  rows: SidebarWorkspaceEntry[],
): SidebarWorkspaceGroup {
  return { key, label: key, leading: { kind: "status", bucket: key }, rows };
}

/** Workspace keys of the rendered rows, in list order. */
function rendered(items: readonly StatusListItem[]): string[] {
  return items.flatMap((item) => (item.kind === "workspace" ? [item.workspace.workspaceKey] : []));
}

describe("active workspace families", () => {
  test.each(["running", "attention", "needs_input", "failed"] as const)(
    "keeps %s families visible beyond count and age windows",
    (statusBucket) => {
      const rows = ["one", "two", "three"].map((id) => {
        const row = workspace(id, []);
        row.statusBucket = statusBucket;
        row.statusEnteredAt = new Date("2020-01-01T00:00:00Z");
        return row;
      });
      const result = buildStatusListItems({
        groups: [bucketGroup(statusBucket, rows)],
        collapsedGroupKeys: new Set(),
        expandedGroupKeys: new Set(),
        initialCount: 1,
        updatedWithin: { days: 1, now: Date.parse("2026-11-03T12:00:00Z") },
      });
      expect(
        result.filter((item) => item.kind === "workspace").map((item) => item.workspace),
      ).toEqual(rows);
      expect(result.at(-1)).toEqual({
        kind: "footer",
        groupKey: statusBucket,
        expanded: false,
        canToggle: false,
      });
    },
  );

  test("completion restores Done age limits while selection, group collapse and Show less stay independent", () => {
    const recent = {
      ...workspace("recent", []),
      statusEnteredAt: new Date("2026-11-03T12:00:00Z"),
    };
    const old = { ...workspace("old", []), statusEnteredAt: new Date("2020-01-01T00:00:00Z") };
    const input = {
      collapsedGroupKeys: new Set<string>(),
      expandedGroupKeys: new Set<string>(),
      initialCount: 1,
      updatedWithin: { days: 1, now: Date.parse("2026-11-03T12:00:00Z") },
    };
    const running = { ...old, statusBucket: "running" as const };
    const attention = { ...old, statusBucket: "attention" as const };
    const runningItems = buildStatusListItems({
      ...input,
      groups: [bucketGroup("running", [running]), bucketGroup("done", [recent])],
    });
    const attentionItems = buildStatusListItems({
      ...input,
      groups: [bucketGroup("attention", [attention]), bucketGroup("done", [recent])],
    });
    expect(rendered(runningItems)).toEqual([old.workspaceKey, recent.workspaceKey]);
    expect(rendered(attentionItems)).toEqual([old.workspaceKey, recent.workspaceKey]);
    expect(statusListItemKey(runningItems[1]!)).toBe(statusListItemKey(attentionItems[1]!));
    const doneInput = { ...input, groups: [bucketGroup("done", [recent, old])] };
    expect(rendered(buildStatusListItems(doneInput))).toEqual([recent.workspaceKey]);
    expect(buildStatusListItems(doneInput).at(-1)).toMatchObject({
      expanded: false,
      canToggle: true,
    });
    expect(
      rendered(buildStatusListItems({ ...doneInput, activeWorkspaceKey: old.workspaceKey })),
    ).toEqual([recent.workspaceKey, old.workspaceKey]);
    const expanded = buildStatusListItems({ ...doneInput, expandedGroupKeys: new Set(["done"]) });
    expect(rendered(expanded)).toEqual([recent.workspaceKey, old.workspaceKey]);
    expect(expanded.at(-1)).toMatchObject({ expanded: true, canToggle: true });
    expect(
      rendered(
        buildStatusListItems({
          ...input,
          groups: [bucketGroup("running", [running])],
          collapsedGroupKeys: new Set(["running"]),
        }),
      ),
    ).toEqual([]);
  });

});
