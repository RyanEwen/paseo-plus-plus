import { describe, expect, test } from "vitest";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { SidebarWorkspaceGroup } from "./sidebar-labels";
import { buildStatusListItems, statusListItemKey } from "./status-list-items";
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
