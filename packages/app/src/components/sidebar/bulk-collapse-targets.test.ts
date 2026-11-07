import { describe, expect, it } from "vitest";
import type { SidebarProjectEntry, SidebarWorkspacePlacement } from "@/hooks/use-sidebar-workspaces-list";
import type { SidebarWorkspaceGroup } from "./sidebar-labels";
import { resolveSidebarCollapseTargets } from "./bulk-collapse-targets";

function makePlacement(id: string, projectViewKey = "project"): SidebarWorkspacePlacement {
  return {
    workspaceKey: `srv:${id}`,
    serverId: "srv",
    workspaceId: id,
    projectViewKey,
    projectName: "Project",
    projectKind: "git",
    workspaceKind: "worktree",
    name: id,
  };
}

function makeProject(
  workspaces: SidebarWorkspacePlacement[],
  viewKey = "project",
): SidebarProjectEntry {
  return {
    viewKey,
    projectName: "Project",
    projectKind: "git",
    iconWorkingDir: `/repo/${viewKey}`,
    hosts: [
      {
        serverId: "srv",
        projectId: viewKey,
        iconWorkingDir: `/repo/${viewKey}`,
        worktreeSupport: "supported",
      },
    ],
    workspaces,
  };
}

const NEEDS_INPUT_GROUP: SidebarWorkspaceGroup = {
  key: "needs_input",
  label: "Needs input",
  rows: [],
  leading: { kind: "status", bucket: "needs_input" },
};

/**
 * One project with a globally pinned workspace and an unpinned one, plus an empty project, as
 * the projection renders them: the pinned row moves to the Pinned section.
 */
function projectWithEmptyNeighbour(groupMode: "project" | "status") {
  const pinned = makePlacement("pinned");
  const unpinned = makePlacement("unpinned");
  const empty = makeProject([], "empty");
  return {
    projects: [makeProject([pinned, unpinned]), empty],
    groupMode,
    pinnedGroups: { pinnedChats: [pinned], unpinnedProjects: [makeProject([unpinned]), empty] },
    workspaceGroups: groupMode === "status" ? [NEEDS_INPUT_GROUP] : [],
  };
}

/** A single project whose only workspace is globally pinned. */
function allPinnedProject(groupMode: "project" | "status") {
  const pinned = makePlacement("pinned");
  return {
    projects: [makeProject([pinned])],
    groupMode,
    pinnedGroups: { pinnedChats: [pinned], unpinnedProjects: [makeProject([])] },
    workspaceGroups: [],
  };
}

describe("bulk collapse targets", () => {
  it("targets only the pinned section when every workspace is globally pinned in status mode", () => {
    const targets = resolveSidebarCollapseTargets({
      ...allPinnedProject("status"),
      groupEmptyProjects: true,
    });
    expect(targets).toEqual({ projectKeys: [], workspaceGroupKeys: [], includePinned: true });
  });

  it("collapses all-pinned project headers in project mode without inventing an empty section", () => {
    const targets = resolveSidebarCollapseTargets({
      ...allPinnedProject("project"),
      groupEmptyProjects: true,
    });
    expect(targets).toEqual({ projectKeys: ["project"], workspaceGroupKeys: [], includePinned: true });
  });

  it.each([
    ["project", ["project", "empty"], ["no-unarchived-workspaces"]],
    ["status", ["empty"], ["needs_input", "no-unarchived-workspaces"]],
  ] as const)(
    "targets rendered headers, groups and the Empty projects group in %s mode",
    (groupMode, projectKeys, workspaceGroupKeys) => {
      const targets = resolveSidebarCollapseTargets({
        ...projectWithEmptyNeighbour(groupMode),
        groupEmptyProjects: true,
      });
      expect(targets).toEqual({ projectKeys, workspaceGroupKeys, includePinned: true });
    },
  );

  it.each([
    ["project", []],
    ["status", ["needs_input"]],
  ] as const)(
    "leaves out the Empty projects group in %s mode while that grouping is off",
    (groupMode, workspaceGroupKeys) => {
      const targets = resolveSidebarCollapseTargets({
        ...projectWithEmptyNeighbour(groupMode),
        groupEmptyProjects: false,
      });
      expect(targets.workspaceGroupKeys).toEqual(workspaceGroupKeys);
    },
  );
});
