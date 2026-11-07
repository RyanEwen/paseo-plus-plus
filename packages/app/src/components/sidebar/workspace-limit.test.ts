import { describe, expect, it, test } from "vitest";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { limitSidebarWorkspaces, parseSidebarWorkspaceCount } from "./workspace-limit";

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

describe("workspace count limits", () => {
  test("accepts arbitrary positive safe integers without coercing invalid input", () => {
    for (const text of ["", "0", "-1", "2.5", "2e3", "12x", "Infinity", "9007199254740992"]) {
      expect(parseSidebarWorkspaceCount(text)).toBeNull();
    }
    expect(parseSidebarWorkspaceCount(" 37 ")).toBe(37);
    expect(parseSidebarWorkspaceCount("001")).toBe(1);
    expect(parseSidebarWorkspaceCount(String(Number.MAX_SAFE_INTEGER))).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });
});

describe("workspace updated-within limits", () => {
  const now = Date.parse("2026-10-16T12:00:00Z");
  const cutoff = now - 86_400_000;
  const rows = [
    { ...workspace("old", []), statusEnteredAt: new Date(cutoff - 1) },
    { ...workspace("boundary", []), statusEnteredAt: new Date(cutoff) },
    { ...workspace("recent", []), statusEnteredAt: new Date(now - 60_000) },
    { ...workspace("unknown", []), statusEnteredAt: null },
    { ...workspace("invalid", []), statusEnteredAt: new Date(Number.NaN) },
    { ...workspace("future", []), statusEnteredAt: new Date(now + 60_000) },
  ];
  const updatedWithin = {
    days: 1,
    now,
    getStatusEnteredAt: (row: SidebarWorkspaceEntry) => row.statusEnteredAt,
  };

  test("filters by status time before applying the count without reordering rows", () => {
    const result = limitSidebarWorkspaces({
      items: rows,
      initialCount: 2,
      expanded: false,
      updatedWithin,
    });
    expect(result.visibleItems.map((row) => row.workspaceId)).toEqual(["boundary", "recent"]);
    expect(result.canToggle).toBe(true);
    expect(rows.map((row) => row.workspaceId)).toEqual([
      "old",
      "boundary",
      "recent",
      "unknown",
      "invalid",
      "future",
    ]);
  });

  test("age still applies when the count is unlimited, with inclusive cutoff and clock-skew tolerance", () => {
    expect(
      limitSidebarWorkspaces({
        items: rows,
        initialCount: null,
        expanded: false,
        updatedWithin,
      }).visibleItems.map((row) => row.workspaceId),
    ).toEqual(["boundary", "recent", "future"]);
  });

  test("Show more reveals every older or undated row and Show less restores both limits", () => {
    const result = limitSidebarWorkspaces({
      items: rows,
      initialCount: 1,
      expanded: true,
      updatedWithin,
    });
    expect(result.visibleItems).toEqual(rows);
    expect(result.canToggle).toBe(true);
    expect(
      limitSidebarWorkspaces({
        items: rows,
        initialCount: 1,
        expanded: false,
        updatedWithin,
      }).visibleItems.map((row) => row.workspaceId),
    ).toEqual(["boundary"]);
  });

  test("disabled age filtering preserves undated rows and the existing count policy", () => {
    expect(
      limitSidebarWorkspaces({ items: rows, initialCount: 1, expanded: false }).visibleItems,
    ).toEqual([rows[0]]);
    expect(
      limitSidebarWorkspaces({ items: rows, initialCount: null, expanded: false }).visibleItems,
    ).toEqual(rows);
  });
});

describe("limitSidebarWorkspaces keeps the open workspace", () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({
    id: `row-${index}`,
    statusEnteredAt: new Date(Date.parse("2026-10-16T12:00:00Z") - index * 86_400_000),
  }));
  const ids = (items: readonly { id: string }[]) => items.map((item) => item.id);
  const isOpen = (id: string) => (item: { id: string }) => item.id === id;

  it("adds an open workspace beyond the count window in its saved position", () => {
    const result = limitSidebarWorkspaces({
      items: rows,
      initialCount: 7,
      expanded: false,
      keep: isOpen("row-9"),
    });
    expect(ids(result.visibleItems)).toEqual([...ids(rows.slice(0, 7)), "row-9"]);
    expect(result.canToggle).toBe(true);
  });

  it("adds an open workspace older than the age window", () => {
    const now = Date.parse("2026-10-16T12:00:00Z");
    const result = limitSidebarWorkspaces({
      items: rows,
      initialCount: null,
      expanded: false,
      updatedWithin: { days: 2, now, getStatusEnteredAt: (row) => row.statusEnteredAt },
      keep: isOpen("row-5"),
    });
    expect(ids(result.visibleItems)).toEqual(["row-0", "row-1", "row-2", "row-5"]);
  });

  it("adds nothing when the open workspace is already inside the window", () => {
    const result = limitSidebarWorkspaces({
      items: rows,
      initialCount: 7,
      expanded: false,
      keep: isOpen("row-3"),
    });
    expect(ids(result.visibleItems)).toEqual(ids(rows.slice(0, 7)));
  });

  it("shows every row once when expanded", () => {
    const result = limitSidebarWorkspaces({
      items: rows,
      initialCount: 7,
      expanded: true,
      keep: isOpen("row-9"),
    });
    expect(ids(result.visibleItems)).toEqual(ids(rows));
  });
});
