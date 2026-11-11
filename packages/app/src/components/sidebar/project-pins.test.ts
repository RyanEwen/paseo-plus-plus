import { describe, expect, it } from "vitest";
import type { SidebarWorkspacePlacement } from "@/hooks/use-sidebar-workspaces-list";
import {
  arrangeProjectPinnedWorkspaces,
  isProjectPinnedEntry,
  collectProjectPinnedKeys,
} from "./project-pins";

function row(name: string): SidebarWorkspacePlacement {
  return {
    workspaceKey: `srv:${name}`,
    serverId: "srv",
    workspaceId: name,
    projectViewKey: "project",
    projectName: "Project",
    projectKind: "git",
    workspaceKind: "worktree",
    name,
  };
}

const rows = [row("a"), row("older-pin"), row("b"), row("newer-pin")];
const entriesByKey = new Map([
  ["srv:a", { projectPinnedAt: null }],
  ["srv:older-pin", { projectPinnedAt: "2026-10-10T12:00:00.000Z" }],
  ["srv:b", { projectPinnedAt: null }],
  ["srv:newer-pin", { projectPinnedAt: "2026-10-11T12:00:00.000Z" }],
]);

function keys(workspaces: SidebarWorkspacePlacement[]): string[] {
  return workspaces.map((workspace) => workspace.workspaceKey);
}

describe("project pins", () => {
  it("treats a row as pinned only while the feature is on", () => {
    expect(isProjectPinnedEntry({ projectPinnedAt: "2026-10-10T12:00:00.000Z" }, true)).toBe(true);
    expect(isProjectPinnedEntry({ projectPinnedAt: "2026-10-10T12:00:00.000Z" }, false)).toBe(
      false,
    );
    expect(isProjectPinnedEntry({ projectPinnedAt: null }, true)).toBe(false);
    expect(isProjectPinnedEntry(undefined, true)).toBe(false);
  });

  it("collects the pin partition's keys", () => {
    expect([...collectProjectPinnedKeys(rows, entriesByKey, true)]).toEqual([
      "srv:older-pin",
      "srv:newer-pin",
    ]);
    expect([...collectProjectPinnedKeys(rows, entriesByKey, false)]).toEqual([]);
  });

  it("puts the newest pin first and keeps ordinary rows in their sorted order", () => {
    const arranged = arrangeProjectPinnedWorkspaces({
      workspaces: rows,
      entriesByKey,
      enabled: true,
      storedPinOrder: [],
    });
    expect(keys(arranged)).toEqual(["srv:newer-pin", "srv:older-pin", "srv:a", "srv:b"]);
  });

  it("applies the saved manual pin order over recency", () => {
    const arranged = arrangeProjectPinnedWorkspaces({
      workspaces: rows,
      entriesByKey,
      enabled: true,
      storedPinOrder: ["srv:older-pin", "srv:newer-pin"],
    });
    expect(keys(arranged)).toEqual(["srv:older-pin", "srv:newer-pin", "srv:a", "srv:b"]);
  });

  it("leaves rows untouched when the feature is off", () => {
    const arranged = arrangeProjectPinnedWorkspaces({
      workspaces: rows,
      entriesByKey,
      enabled: false,
      storedPinOrder: [],
    });
    expect(arranged).toBe(rows);
  });
});
