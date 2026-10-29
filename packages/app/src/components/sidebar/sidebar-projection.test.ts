import {
  buildWorkspaceHumanAttentionKeys,
  createWorkspaceHumanAttentionSelector,
  type WorkspaceAttentionAgent,
} from "./workspace-tree-attention";
import {
  orderWorkspaceFamilies,
  resolveWorkspaceParents,
  summarizeWorkspaceChildren,
  workspaceCollapseKey,
  type WorkspaceTreeAgent,
} from "./workspace-tree";
import { filterSidebarByText } from "./sidebar-text-filter";
import { limitSidebarWorkspaces } from "./workspace-limit";
import { summarizeSidebarProjectActivity } from "./sidebar-project-activity";
import { setSectionsCollapsed } from "@/stores/sidebar-collapsed-sections-store/state";
import { i18n } from "@/i18n/i18next";
import { describe, expect, it } from "vitest";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import {
  filterSidebarProjects,
  arrangeSidebarProjects,
  sortSidebarProjectsByName,
} from "./sidebar-arrangement";
import { buildSidebarProjection, resolveSidebarCollapseTargets } from "./sidebar-projection";
import { buildStatusListItems } from "./status-list-items";
import type { WorkspaceDescriptor } from "@/stores/session-store";

function makeWorkspace(
  id: string,
  statusBucket: SidebarWorkspaceEntry["statusBucket"] = "done",
  labels: string[] = [],
  projectViewKey = "project",
) {
  const placement: SidebarWorkspacePlacement = {
    workspaceKey: `srv:${id}`,
    serverId: "srv",
    workspaceId: id,
    projectViewKey,
    projectName: "Project",
    projectKind: "git",
    workspaceKind: "worktree",
    name: id,
  };
  const entry: SidebarWorkspaceEntry = {
    ...placement,
    workspaceDirectory: "",
    workspaceDirectoryLabel: "",
    title: null,
    currentBranch: null,
    statusBucket,
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    prHint: null,
    archiveHasUncommittedChanges: null,
    archiveUnpushedCommitCount: null,
    scripts: [],
    hasRunningScripts: false,
    labels,
  };
  return { placement, entry };
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
        worktreeSupport: "supported" as const,
      },
    ],
    workspaces,
  };
}

function projectionInput(options?: {
  groupMode?: "project" | "status";
  pinnedCollapsed?: boolean;
}) {
  const pinned = makeWorkspace("pinned", "running");
  const unpinned = makeWorkspace("unpinned", "needs_input");
  return {
    projects: [makeProject([pinned.placement, unpinned.placement])],
    pinnedKeys: {
      pinnedWorkspaceKeys: [pinned.placement.workspaceKey],
      pinnedAtByKey: { [pinned.placement.workspaceKey]: "2026-07-12T12:00:00.000Z" },
    },
    pinnedWorkspaceOrder: [],
    projectPinningEnabled: true,
    workspaceSortMode: options?.groupMode === "status" ? ("status" as const) : ("custom" as const),
    workspaceTitleSource: "title" as const,
    statusWorkspaceOrder: [],
    workspaceEntriesByKey: new Map([
      [pinned.entry.workspaceKey, pinned.entry],
      [unpinned.entry.workspaceKey, unpinned.entry],
    ]),
    projectNamesByViewKey: new Map([["project", "Project"]]),
    groupMode: options?.groupMode ?? ("project" as const),
    pinnedCollapsed: options?.pinnedCollapsed ?? false,
    collapsedProjectKeys: new Set<string>(),
    collapsedWorkspaceGroupKeys: new Set<string>(),
    t: i18n.t,
  };
}

/**
 * Two projects, one workspace each, both labelled — so every grouping mode puts rows from more
 * than one project on screen, and a mode that asked for fewer icons than it renders would show it.
 */
function twoProjectInput(groupMode: "project" | "status") {
  const first = makeWorkspace("first", "running", ["Urgent"], "project");
  const second = makeWorkspace("second", "needs_input", ["Backend"], "other-project");
  return {
    ...projectionInput({ groupMode }),
    projects: [makeProject([first.placement]), makeProject([second.placement], "other-project")],
    pinnedKeys: { pinnedWorkspaceKeys: [] as string[], pinnedAtByKey: {} },
    workspaceEntriesByKey: new Map([
      [first.entry.workspaceKey, first.entry],
      [second.entry.workspaceKey, second.entry],
    ]),
    projectNamesByViewKey: new Map([
      ["project", "Project"],
      ["other-project", "Other project"],
    ]),
  };
}

describe("buildSidebarProjection", () => {
  it("keeps full status membership in collapsed and limited headers as workspaces move or are filtered", () => {
    const input = twoProjectInput("status");
    const third = makeWorkspace("third", "running", ["Backend"]);
    third.entry.projectPinnedAt = "2026-10-20T12:00:00.000Z";
    input.projects[0].workspaces.push(third.placement);
    input.workspaceEntriesByKey.set(third.entry.workspaceKey, third.entry);

    const listItems = () =>
      buildStatusListItems({
        groups: buildSidebarProjection(input).workspaceGroups,
        collapsedGroupKeys: new Set(["needs_input"]),
        expandedGroupKeys: new Set(),
        initialCount: 1,
      });
    const memberships = () => {
      const headers = [];
      for (const item of listItems()) {
        if (item.kind !== "header") continue;
        headers.push({
          key: item.group.key,
          workspaceIds: item.group.rows.map((row) => row.workspaceId),
        });
      }
      return headers;
    };

    expect(memberships()).toEqual([
      { key: "needs_input", workspaceIds: ["second"] },
      { key: "running", workspaceIds: ["first", "third"] },
    ]);
    expect(listItems().filter((item) => item.kind === "workspace")).toHaveLength(1);

    // One workspace changes group, even when the destination's rows are collapsed.
    third.entry.statusBucket = "needs_input";
    expect(memberships()).toEqual([
      { key: "needs_input", workspaceIds: ["second", "third"] },
      { key: "running", workspaceIds: ["first"] },
    ]);

    // Global pins leave status membership; project pins above remained in their bucket.
    input.pinnedKeys.pinnedWorkspaceKeys = [third.entry.workspaceKey];
    expect(memberships()).toEqual([
      { key: "needs_input", workspaceIds: ["second"] },
      { key: "running", workspaceIds: ["first"] },
    ]);

    const filtered = filterSidebarByText({
      projects: input.projects,
      entries: input.workspaceEntriesByKey,
      projectNames: input.projectNamesByViewKey,
      text: "first",
      workspaceTitleSource: "title",
      showBranch: true,
    });
    input.projects = filtered.projects;
    input.workspaceEntriesByKey = new Map(filtered.entries);
    expect(memberships()).toEqual([{ key: "running", workspaceIds: ["first"] }]);
  });

  it("sorts equal statuses newest first without changing priority, pins, ties, or saved order", () => {
    const input = projectionInput();
    const old = makeWorkspace("old");
    const newest = makeWorkspace("newest");
    const tied = makeWorkspace("tied");
    const unknown = makeWorkspace("unknown");
    const missing = makeWorkspace("missing");
    const failed = makeWorkspace("failed", "failed");
    const attention = makeWorkspace("attention", "attention");
    const running = makeWorkspace("running", "running");
    old.entry.statusEnteredAt = new Date("2026-10-04T12:00:00Z");
    newest.entry.statusEnteredAt = new Date("2026-10-11T12:00:00Z");
    tied.entry.statusEnteredAt = newest.entry.statusEnteredAt;
    const workspaces = [unknown, old, missing, newest, tied, running, attention, failed];
    input.projects[0].workspaces.push(...workspaces.map(({ placement }) => placement));
    for (const { entry } of workspaces) input.workspaceEntriesByKey.set(entry.workspaceKey, entry);
    input.workspaceEntriesByKey.delete(missing.entry.workspaceKey);
    const savedOrder = input.projects[0].workspaces.map((row) => row.name);
    const projection = buildSidebarProjection({ ...input, workspaceSortMode: "status" });
    const sorted = [
      "unpinned",
      "failed",
      "attention",
      "running",
      "newest",
      "tied",
      "old",
      "unknown",
      "missing",
    ];
    expect(projection.pinnedGroups.unpinnedProjects[0].workspaces.map((row) => row.name)).toEqual(
      sorted,
    );
    expect(projection.pinnedGroups.pinnedChats.map((row) => row.name)).toEqual(["pinned"]);
    expect(projection.shortcutModel.shortcutTargets.map((row) => row.workspaceId)).toEqual([
      "pinned",
      ...sorted,
    ]);
    expect(input.projects[0].workspaces.map((row) => row.name)).toEqual(savedOrder);
    const custom = buildSidebarProjection(input);
    expect(custom.pinnedGroups.unpinnedProjects[0].workspaces.map((row) => row.name)).toEqual(
      savedOrder.slice(1),
    );
  });

  it("sorts workspace rows without changing pins, groups, or saved custom order", () => {
    const input = projectionInput();
    const zeta = makeWorkspace("Zeta", "done");
    const alpha = makeWorkspace("Alpha", "running");
    input.projects[0].workspaces.push(zeta.placement, alpha.placement);
    input.workspaceEntriesByKey.set(zeta.entry.workspaceKey, zeta.entry);
    input.workspaceEntriesByKey.set(alpha.entry.workspaceKey, alpha.entry);
    const named = buildSidebarProjection({ ...input, workspaceSortMode: "name" });
    expect(named.pinnedGroups.unpinnedProjects[0].workspaces.map((row) => row.name)).toEqual([
      "Alpha",
      "unpinned",
      "Zeta",
    ]);
    expect(named.pinnedGroups.pinnedChats.map((row) => row.name)).toEqual(["pinned"]);
    const status = buildSidebarProjection({ ...input, workspaceSortMode: "status" });
    expect(status.pinnedGroups.unpinnedProjects[0].workspaces.map((row) => row.name)).toEqual([
      "unpinned",
      "Alpha",
      "Zeta",
    ]);
    const custom = buildSidebarProjection({ ...input, workspaceSortMode: "custom" });
    expect(custom.pinnedGroups.unpinnedProjects[0].workspaces.map((row) => row.name)).toEqual([
      "unpinned",
      "Zeta",
      "Alpha",
    ]);
    expect(input.projects[0].workspaces.map((row) => row.name)).toEqual([
      "pinned",
      "unpinned",
      "Zeta",
      "Alpha",
    ]);
    zeta.entry.title = "Aardvark";
    const renamed = buildSidebarProjection({ ...input, workspaceSortMode: "name" });
    expect(renamed.pinnedGroups.unpinnedProjects[0].workspaces.map((row) => row.name)).toEqual([
      "Alpha",
      "unpinned",
      "Zeta",
    ]);
    expect([...renamed.shortcutModel.shortcutIndexByWorkspaceKey.keys()]).toEqual([
      "srv:pinned",
      "srv:Alpha",
      "srv:unpinned",
      "srv:Zeta",
    ]);
  });

  for (const groupMode of ["project", "status"] as const) {
    it(`sorts by visible branches with name fallback in ${groupMode} grouping`, () => {
      const alpha = makeWorkspace("Alpha");
      const zeta = makeWorkspace("Zeta");
      const fallback = makeWorkspace("Middle");
      alpha.entry.currentBranch = "zeta-branch";
      zeta.entry.currentBranch = "alpha-branch";
      zeta.entry.title = "Hidden title";
      const workspaces = [alpha, fallback, zeta];
      const projection = buildSidebarProjection({
        ...projectionInput({ groupMode }),
        projects: [makeProject(workspaces.map((workspace) => workspace.placement))],
        workspaceEntriesByKey: new Map(workspaces.map(({ entry }) => [entry.workspaceKey, entry])),
        workspaceSortMode: "name",
        workspaceTitleSource: "branch",
      });
      expect(projection.shortcutModel.shortcutTargets.map((target) => target.workspaceId)).toEqual([
        "Zeta",
        "Middle",
        "Alpha",
      ]);
    });
  }

  it("sorts within status groups and restores custom order across projects", () => {
    const input = twoProjectInput("status");
    const zeta = makeWorkspace("Zeta", "running", [], "other-project");
    const alpha = makeWorkspace("Alpha", "running");
    input.projects[0].workspaces.push(alpha.placement);
    input.projects[1].workspaces.push(zeta.placement);
    input.workspaceEntriesByKey.set(zeta.entry.workspaceKey, zeta.entry);
    input.workspaceEntriesByKey.set(alpha.entry.workspaceKey, alpha.entry);
    const named = buildSidebarProjection({ ...input, workspaceSortMode: "name" });
    expect(named.workspaceGroups.map((group) => group.key)).toEqual(["needs_input", "running"]);
    expect(named.workspaceGroups[1].rows.map((row) => row.name)).toEqual([
      "Alpha",
      "first",
      "Zeta",
    ]);
    const custom = buildSidebarProjection({
      ...input,
      workspaceSortMode: "custom",
      statusWorkspaceOrder: ["srv:Zeta", "srv:first", "srv:Alpha"],
    });
    expect(custom.workspaceGroups[1].rows.map((row) => row.name)).toEqual([
      "Zeta",
      "first",
      "Alpha",
    ]);
  });

  it("filters projects by unarchived workspace membership before splitting pins", () => {
    const input = projectionInput();
    const empty = makeProject([], "empty");
    input.projects.push(empty);
    for (const groupMode of ["project", "status"] as const) {
      const projects = filterSidebarProjects(input.projects, "unarchived");
      const projection = buildSidebarProjection({ ...input, projects, groupMode });
      expect(projects.map((project) => project.viewKey)).toEqual(["project"]);
      expect(projection.pinnedGroups.pinnedChats.map((row) => row.workspaceId)).toEqual(["pinned"]);
    }
    expect(filterSidebarProjects(input.projects, "all").map((project) => project.viewKey)).toEqual([
      "project",
      "empty",
    ]);
  });

  it("keeps empty projects available in status mode without treating all-pinned projects as empty", () => {
    const input = projectionInput({ groupMode: "status" });
    input.projects = [makeProject([input.projects[0]!.workspaces[0]!]), makeProject([], "empty")];
    const projection = buildSidebarProjection(input);
    const emptyProjects = input.projects.filter((project) => project.workspaces.length === 0);
    expect(emptyProjects.map((project) => project.viewKey)).toEqual(["empty"]);
    // Removing pinned rows must not hide the occupied project's creation action.
    expect(
      filterSidebarProjects(
        projection.pinnedGroups.unpinnedProjects,
        "unarchived",
        input.projects,
      ).map((project) => project.viewKey),
    ).toEqual(["project"]);
    expect(projection.projectIconTargets.map((target) => target.projectViewKey)).toEqual([
      "project",
      "empty",
    ]);
  });

  it("alphabetizes empty project headers while retaining their custom order and stable ties", () => {
    const zeta = { ...makeProject([], "zeta"), projectName: "Zeta" };
    const alpha = { ...makeProject([], "alpha"), projectName: "Alpha" };
    const alphaOtherHost = { ...makeProject([], "alpha-other-host"), projectName: "Alpha" };
    const emptyProjects = [zeta, alpha, alphaOtherHost];
    expect(sortSidebarProjectsByName({ projects: emptyProjects })).toEqual([
      alpha,
      alphaOtherHost,
      zeta,
    ]);
    expect(emptyProjects).toEqual([zeta, alpha, alphaOtherHost]);
  });

  it("sorts project headers by name without changing their workspace order", () => {
    const input = twoProjectInput("project");
    const extra = makeWorkspace("extra", "needs_input");
    input.projects[0]!.workspaces.push(extra.placement);
    input.workspaceEntriesByKey.set(extra.entry.workspaceKey, extra.entry);
    const projects = arrangeSidebarProjects({
      projects: input.projects,
      mode: "project",
      entries: input.workspaceEntriesByKey,
      projectNames: input.projectNamesByViewKey,
    });
    expect(projects.map((project) => project.viewKey)).toEqual(["other-project", "project"]);
    expect(projects[1]).toBe(input.projects[0]);
    expect(projects[1]!.workspaces.map((row) => row.workspaceId)).toEqual(["first", "extra"]);
    const projection = buildSidebarProjection({ ...input, projects });
    expect(projection.shortcutModel.shortcutTargets.map((target) => target.workspaceId)).toEqual([
      "second",
      "first",
      "extra",
    ]);
    expect(input.projects.map((project) => project.viewKey)).toEqual(["project", "other-project"]);
  });

  it("sorts projects by aggregate status, including pinned workspaces, and keeps ties stable", () => {
    const input = twoProjectInput("project");
    const urgent = makeWorkspace("urgent", "needs_input");
    input.projects[0]!.workspaces.push(urgent.placement);
    input.workspaceEntriesByKey.set(urgent.entry.workspaceKey, urgent.entry);
    input.pinnedKeys = { pinnedWorkspaceKeys: [urgent.placement.workspaceKey], pinnedAtByKey: {} };
    input.projects.push(makeProject([], "empty"));
    const projects = arrangeSidebarProjects({
      projects: input.projects,
      mode: "status",
      entries: input.workspaceEntriesByKey,
      projectNames: input.projectNamesByViewKey,
    });
    expect(projects.map((project) => project.viewKey)).toEqual([
      "project",
      "other-project",
      "empty",
    ]);
    expect(projects[0]!.workspaces.map((row) => row.workspaceId)).toEqual(["first", "urgent"]);
    input.workspaceEntriesByKey.get("srv:urgent")!.statusBucket = "done";
    expect(
      arrangeSidebarProjects({
        projects: input.projects,
        mode: "status",
        entries: input.workspaceEntriesByKey,
        projectNames: input.projectNamesByViewKey,
      }).map((project) => project.viewKey),
    ).toEqual(["other-project", "project", "empty"]);
    expect(
      arrangeSidebarProjects({
        projects: input.projects,
        mode: "custom",
        entries: input.workspaceEntriesByKey,
        projectNames: input.projectNamesByViewKey,
      }),
    ).toBe(input.projects);
  });

  // The rule that outlived the bug it was written for: a project icon is fetched per project, so
  // whatever a mode groups by, the rows it produces can only reference projects already covered.
  for (const groupMode of ["project", "status"] as const) {
    it(`covers every row ${groupMode} grouping renders with a project icon target`, () => {
      const projection = buildSidebarProjection(twoProjectInput(groupMode));
      const covered = new Set(projection.projectIconTargets.map((target) => target.projectViewKey));

      // Every leading visual the sidebar can paint from this projection: pinned rows, grouped
      // rows, project headers and the rows under them.
      const renderedProjectViewKeys = new Set<string>();
      for (const entry of projection.pinnedGroups.pinnedChats) {
        renderedProjectViewKeys.add(entry.projectViewKey);
      }
      for (const group of projection.workspaceGroups) {
        for (const entry of group.rows) renderedProjectViewKeys.add(entry.projectViewKey);
      }
      for (const project of projection.pinnedGroups.unpinnedProjects) {
        renderedProjectViewKeys.add(project.viewKey);
        for (const entry of project.workspaces) renderedProjectViewKeys.add(entry.projectViewKey);
      }

      expect([...renderedProjectViewKeys].sort()).toEqual(["other-project", "project"]);
      expect([...renderedProjectViewKeys].filter((viewKey) => !covered.has(viewKey))).toEqual([]);
    });
  }

  it("uses one pin-aware projection for project rows and shortcut order", () => {
    const projection = buildSidebarProjection(projectionInput());

    expect(projection.pinnedGroups.pinnedChats.map((entry) => entry.workspaceId)).toEqual([
      "pinned",
    ]);
    const remainingProject = projection.pinnedGroups.unpinnedProjects[0];
    expect(remainingProject?.workspaces.map((entry) => entry.workspaceId)).toEqual(["unpinned"]);
    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv", workspaceId: "pinned" },
      { serverId: "srv", workspaceId: "unpinned" },
    ]);
  });

  it("keeps pinned chats above status groups and removes them from those groups", () => {
    const projection = buildSidebarProjection(projectionInput({ groupMode: "status" }));

    expect(projection.workspaceGroups.map((group) => group.key)).toEqual(["needs_input"]);
    expect(projection.workspaceGroups[0]?.rows.map((entry) => entry.workspaceId)).toEqual([
      "unpinned",
    ]);
    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv", workspaceId: "pinned" },
      { serverId: "srv", workspaceId: "unpinned" },
    ]);
  });

  it("does not number pinned chats while the pinned section is collapsed", () => {
    const projection = buildSidebarProjection(
      projectionInput({ groupMode: "status", pinnedCollapsed: true }),
    );

    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv", workspaceId: "unpinned" },
    ]);
  });
});

describe("project workspace pins", () => {
  it.each(["custom", "name", "status"] as const)(
    "keeps pins inside their project ahead of %s sorted siblings",
    (mode) => {
      const input = projectionInput();
      const ordinary = makeWorkspace("aaa", "needs_input");
      const pin = makeWorkspace("zzz", "done");
      pin.entry.projectPinnedAt = "2026-10-11T12:00:00.000Z";
      input.projects[0]!.workspaces.push(ordinary.placement, pin.placement);
      input.workspaceEntriesByKey.set(ordinary.entry.workspaceKey, ordinary.entry);
      input.workspaceEntriesByKey.set(pin.entry.workspaceKey, pin.entry);
      const before = [...input.projects[0]!.workspaces];
      const result = buildSidebarProjection({ ...input, workspaceSortMode: mode });
      expect(result.pinnedGroups.pinnedChats.map((row) => row.workspaceKey)).toEqual([
        "srv:pinned",
      ]);
      expect(result.pinnedGroups.unpinnedProjects[0]!.workspaces[0]!.workspaceKey).toBe("srv:zzz");
      expect(
        result.shortcutModel.shortcutTargets.slice(0, 2).map((target) => target.workspaceId),
      ).toEqual(["pinned", "zzz"]);
      const collapsed = buildSidebarProjection({
        ...input,
        workspaceSortMode: mode,
        collapsedProjectKeys: new Set(["project"]),
      });
      expect(collapsed.shortcutModel.shortcutTargets.map((target) => target.workspaceId)).toEqual([
        "pinned",
      ]);
      expect(
        filterSidebarProjects(result.pinnedGroups.unpinnedProjects, "unarchived"),
      ).toHaveLength(1);
      expect(input.projects[0]!.workspaces).toEqual(before);
    },
  );

  it("uses recency and saved pin order without changing status grouping", () => {
    const input = projectionInput();
    const older = makeWorkspace("older", "needs_input");
    const newer = makeWorkspace("newer", "done");
    older.entry.projectPinnedAt = "2026-10-10T12:00:00.000Z";
    newer.entry.projectPinnedAt = "2026-10-11T12:00:00.000Z";
    input.projects[0]!.workspaces.push(older.placement, newer.placement);
    input.workspaceEntriesByKey.set(older.entry.workspaceKey, older.entry);
    input.workspaceEntriesByKey.set(newer.entry.workspaceKey, newer.entry);
    const rows = (order: string[]) =>
      buildSidebarProjection({
        ...input,
        pinnedWorkspaceOrder: order,
      }).pinnedGroups.unpinnedProjects[0]!.workspaces.map((row) => row.workspaceKey);
    expect(rows([]).slice(0, 2)).toEqual(["srv:newer", "srv:older"]);
    expect(rows(["srv:older", "srv:newer"]).slice(0, 2)).toEqual(["srv:older", "srv:newer"]);
    const status = buildSidebarProjection({ ...input, groupMode: "status" });
    expect(status.pinnedGroups.pinnedChats).toHaveLength(1);
    expect(
      status.workspaceGroups
        .flatMap((group) => group.rows)
        .filter((row) => row.workspaceKey === "srv:newer"),
    ).toHaveLength(1);
  });
});

describe("bulk collapse targets", () => {
  it("preserves hidden project and empty-group preferences when all children are globally pinned in status mode", () => {
    const input = projectionInput({ groupMode: "status" });
    const pinned = makeWorkspace("pinned", "running");
    input.projects = [makeProject([pinned.placement])];
    input.workspaceEntriesByKey = new Map([[pinned.entry.workspaceKey, pinned.entry]]);
    const projection = buildSidebarProjection(input);
    expect(
      resolveSidebarCollapseTargets({
        ...projection,
        projects: input.projects,
        groupMode: input.groupMode,
        groupEmptyProjects: true,
      }),
    ).toEqual({
      projectKeys: [],
      workspaceGroupKeys: [],
      includePinned: true,
    });
  });
  it("collapses all-pinned project headers in project mode without inventing an empty section", () => {
    const input = projectionInput({ groupMode: "project" });
    const pinned = makeWorkspace("pinned", "running");
    input.projects = [makeProject([pinned.placement])];
    input.workspaceEntriesByKey = new Map([[pinned.entry.workspaceKey, pinned.entry]]);
    const projection = buildSidebarProjection(input);
    expect(
      resolveSidebarCollapseTargets({
        ...projection,
        projects: input.projects,
        groupMode: input.groupMode,
        groupEmptyProjects: true,
      }),
    ).toEqual({ projectKeys: ["project"], workspaceGroupKeys: [], includePinned: true });
  });
  it.each(["project", "status"] as const)(
    "includes genuine empty headers and their section in %s mode",
    (groupMode) => {
      const input = projectionInput({ groupMode });
      input.projects.push(makeProject([], "empty"));
      const projection = buildSidebarProjection(input);
      const targets = resolveSidebarCollapseTargets({
        ...projection,
        projects: input.projects,
        groupMode,
        groupEmptyProjects: true,
      });
      const expectedProjects = groupMode === "project" ? ["project", "empty"] : ["empty"];
      const expectedGroups =
        groupMode === "status"
          ? ["needs_input", "no-unarchived-workspaces"]
          : ["no-unarchived-workspaces"];
      expect(targets).toEqual({
        projectKeys: expectedProjects,
        workspaceGroupKeys: expectedGroups,
        includePinned: true,
      });
      const hiddenPreferences = {
        collapsedProjectKeys: new Set(["hidden-project"]),
        collapsedWorkspaceGroupKeys: new Set(["hidden-status"]),
        collapsedPinned: false,
      };
      const collapsed = setSectionsCollapsed(hiddenPreferences, targets, true);
      expect(setSectionsCollapsed(collapsed, targets, false)).toEqual(hiddenPreferences);
      expect(
        resolveSidebarCollapseTargets({
          ...projection,
          projects: input.projects,
          groupMode,
          groupEmptyProjects: false,
        }).workspaceGroupKeys,
      ).toEqual(groupMode === "status" ? ["needs_input"] : []);
    },
  );
});

describe("optional project pinning", () => {
  it.each(["custom", "name", "status"] as const)(
    "off preserves visible rows and stored pins under %s sorting",
    (mode) => {
      const input = projectionInput();
      const projectPin = makeWorkspace("zzz", "done");
      const ordinary = makeWorkspace("aaa", "needs_input");
      projectPin.entry.projectPinnedAt = "2026-10-12T12:00:00.000Z";
      input.projects[0]!.workspaces.push(ordinary.placement, projectPin.placement);
      input.workspaceEntriesByKey.set(ordinary.entry.workspaceKey, ordinary.entry);
      input.workspaceEntriesByKey.set(projectPin.entry.workspaceKey, projectPin.entry);
      const savedRows = [...input.projects[0]!.workspaces];
      const savedPins = [projectPin.placement.workspaceKey];
      const base = { ...input, workspaceSortMode: mode, pinnedWorkspaceOrder: savedPins };
      const off = buildSidebarProjection({ ...base, projectPinningEnabled: false });
      const on = buildSidebarProjection(base);
      expect(off.pinnedGroups.pinnedChats.map((row) => row.workspaceKey)).toEqual(["srv:pinned"]);
      expect(
        off.pinnedGroups.unpinnedProjects[0]!.workspaces.map((row) => row.workspaceKey),
      ).toContain("srv:zzz");
      expect(off.pinnedGroups.unpinnedProjects[0]!.workspaces[0]!.workspaceKey).not.toBe("srv:zzz");
      expect(on.pinnedGroups.unpinnedProjects[0]!.workspaces[0]!.workspaceKey).toBe("srv:zzz");
      expect(projectPin.entry.projectPinnedAt).toBe("2026-10-12T12:00:00.000Z");
      expect(input.projects[0]!.workspaces).toEqual(savedRows);
      expect(savedPins).toEqual(["srv:zzz"]);
      const statusOn = buildSidebarProjection({ ...base, groupMode: "status" });
      const statusOff = buildSidebarProjection({
        ...base,
        groupMode: "status",
        projectPinningEnabled: false,
      });
      expect(statusOff.workspaceGroups).toEqual(statusOn.workspaceGroups);
    },
  );
});

describe("project activity summaries", () => {
  it("surfaces ready work ahead of working siblings while retaining pins and the working count", () => {
    const working = makeWorkspace("working", "running");
    const ready = makeWorkspace("ready", "attention");
    ready.entry.pinnedAt = "2026-10-20T12:00:00.000Z";
    const project = makeProject([working.placement, ready.placement]);
    const entries = new Map([working, ready].map(({ entry }) => [entry.workspaceKey, entry]));
    const online = new Map([["srv", "online"]] as const);

    expect(summarizeSidebarProjectActivity([project], entries, online).get("project")).toEqual({
      bucket: "attention",
      workingCount: 1,
    });

    ready.entry.statusBucket = "done";
    expect(summarizeSidebarProjectActivity([project], entries, online).get("project")).toEqual({
      bucket: "running",
      workingCount: 1,
    });
    expect(ready.entry.pinnedAt).toBe("2026-10-20T12:00:00.000Z");
  });

  it("includes the complete selectable project catalog and all working children", () => {
    const selected = makeWorkspace("selected", "done", [], "selected-project");
    const first = makeWorkspace("first", "running", [], "other-project");
    const pinned = makeWorkspace("pinned", "running", [], "other-project");
    const projects = [
      makeProject([selected.placement], "selected-project"),
      makeProject([first.placement, pinned.placement], "other-project"),
    ];
    const entries = new Map(
      [selected, first, pinned].map(({ entry }) => [entry.workspaceKey, entry]),
    );
    const summary = summarizeSidebarProjectActivity(
      projects,
      entries,
      new Map([["srv", "online"]]),
    );
    expect(summary.get("other-project")).toEqual({ bucket: "running", workingCount: 2 });
    expect(summary.get("selected-project")).toEqual({ bucket: "done", workingCount: 0 });
  });

  it("keeps needs-input ahead of working while retaining the working count", () => {
    const first = makeWorkspace("first", "running");
    const second = makeWorkspace("second", "needs_input");
    const entries = new Map([first, second].map(({ entry }) => [entry.workspaceKey, entry]));
    expect(
      summarizeSidebarProjectActivity(
        [makeProject([first.placement, second.placement])],
        entries,
        new Map([["srv", "online"]]),
      ).get("project"),
    ).toEqual({ bucket: "needs_input", workingCount: 1 });
  });

  it("suppresses stale offline activity and avoids marking unknown or empty projects done", () => {
    const worker = makeWorkspace("worker", "running");
    const entries = new Map([[worker.entry.workspaceKey, worker.entry]]);
    const project = makeProject([worker.placement]);
    expect(
      summarizeSidebarProjectActivity([project], entries, new Map([["srv", "offline"]])).get(
        "project",
      ),
    ).toEqual({ bucket: null, workingCount: 0 });
    expect(
      summarizeSidebarProjectActivity(
        [project, makeProject([], "empty")],
        new Map(),
        new Map([["srv", "online"]]),
      ).get("project"),
    ).toEqual({ bucket: null, workingCount: 0 });
    expect(
      summarizeSidebarProjectActivity(
        [makeProject([], "empty")],
        entries,
        new Map([["srv", "online"]]),
      ).get("empty"),
    ).toEqual({ bucket: null, workingCount: 0 });
  });

  it("updates as runtime entries change without retaining a previous priority", () => {
    const worker = makeWorkspace("worker", "needs_input");
    const project = makeProject([worker.placement]);
    const online = new Map([["srv", "online"]] as const);
    expect(
      summarizeSidebarProjectActivity(
        [project],
        new Map([[worker.entry.workspaceKey, worker.entry]]),
        online,
      ).get("project")?.bucket,
    ).toBe("needs_input");
    expect(
      summarizeSidebarProjectActivity(
        [project],
        new Map([[worker.entry.workspaceKey, { ...worker.entry, statusBucket: "done" }]]),
        online,
      ).get("project")?.bucket,
    ).toBe("done");
  });
});

it("sorts Done before empty/unknown project status while preserving known priorities and stable ties", () => {
  const waiting = makeWorkspace("waiting", "needs_input");
  const failed = makeWorkspace("failed", "failed");
  const attention = makeWorkspace("attention", "attention");
  const running = makeWorkspace("running", "running");
  const doneA = makeWorkspace("done-a", "done");
  const doneB = makeWorkspace("done-b", "done");
  const unknown = makeWorkspace("unknown", "done");
  const entries = new Map(
    [waiting, failed, attention, running, doneA, doneB].map((item) => [
      item.entry.workspaceKey,
      item.entry,
    ]),
  );
  const projects = [
    makeProject([], "empty"),
    makeProject([unknown.placement], "unknown"),
    makeProject([doneB.placement], "done-b"),
    makeProject([running.placement], "running"),
    makeProject([attention.placement], "attention"),
    makeProject([failed.placement], "failed"),
    makeProject([waiting.placement], "waiting"),
    makeProject([doneA.placement], "done-a"),
  ];
  const activity = summarizeSidebarProjectActivity(projects, entries, new Map([["srv", "online"]]));
  expect(
    arrangeSidebarProjects({
      projects,
      mode: "status",
      entries,
      projectNames: new Map(),
      projectActivity: activity,
    }).map((project) => project.viewKey),
  ).toEqual(["waiting", "failed", "attention", "running", "done-b", "done-a", "empty", "unknown"]);
  expect(projects[0]!.viewKey).toBe("empty");
});

it("places a cached offline project after online Done using the same activity as its no-status badge", () => {
  const offline = makeWorkspace("cached", "running");
  offline.placement.serverId = "offline";
  const done = makeWorkspace("done", "done");
  const entries = new Map([
    [offline.entry.workspaceKey, offline.entry],
    [done.entry.workspaceKey, done.entry],
  ]);
  const projects = [
    makeProject([offline.placement], "offline"),
    makeProject([done.placement], "done"),
  ];
  const activity = summarizeSidebarProjectActivity(
    projects,
    entries,
    new Map([
      ["srv", "online"],
      ["offline", "offline"],
    ]),
  );
  expect(
    arrangeSidebarProjects({
      projects,
      mode: "status",
      entries,
      projectNames: new Map(),
      projectActivity: activity,
    }).map((project) => project.viewKey),
  ).toEqual(["done", "offline"]);
});

describe("sidebar transient text projection", () => {
  it("keeps scoped project children on a case-insensitive displayed project-name match", () => {
    const input = twoProjectInput("project");
    const before = input.projects[0]!.workspaces;
    const result = filterSidebarByText({
      projects: input.projects,
      entries: input.workspaceEntriesByKey,
      projectNames: new Map([["project", "Business Accounts"]]),
      text: "  ACCOUNTS  ",
      workspaceTitleSource: "title",
      showBranch: false,
    });
    expect(result.projects.map((project) => project.viewKey)).toEqual(["project"]);
    expect(result.projects[0]!.workspaces).toBe(before);
    const unchanged = filterSidebarByText({
      projects: input.projects,
      entries: input.workspaceEntriesByKey,
      projectNames: new Map(),
      text: "  ",
      workspaceTitleSource: "title",
      showBranch: false,
    });
    expect(unchanged.projects).toBe(input.projects);
    expect(unchanged.entries).toBe(input.workspaceEntriesByKey);
  });
  it("matches workspace names, titles and visible branches without altering the source or revealing hidden branches", () => {
    const first = makeWorkspace("Account editor");
    first.entry.currentBranch = "fix/CSS-Layout";
    first.entry.title = "Customer styling";
    const second = makeWorkspace("Unrelated");
    const project = makeProject([first.placement, second.placement]);
    const input = {
      projects: [project],
      entries: new Map([
        [first.entry.workspaceKey, first.entry],
        [second.entry.workspaceKey, second.entry],
      ]),
      projectNames: new Map(),
      workspaceTitleSource: "title" as const,
      showBranch: true,
    };
    for (const text of ["EDITOR", "customer", "css-layout"]) {
      expect(filterSidebarByText({ ...input, text }).projects[0]!.workspaces).toEqual([
        first.placement,
      ]);
    }
    expect(
      filterSidebarByText({ ...input, text: "css-layout", showBranch: false }).projects,
    ).toEqual([]);
    expect(
      filterSidebarByText({
        ...input,
        text: "css-layout",
        showBranch: false,
        workspaceTitleSource: "branch",
      }).projects[0]!.workspaces,
    ).toEqual([first.placement]);
    expect(project.workspaces).toHaveLength(2);
  });
  it.each(["project", "status"] as const)(
    "filters pinned and ordinary rows consistently before the %s projection",
    (groupMode) => {
      const input = projectionInput({ groupMode });
      input.workspaceEntriesByKey.get("srv:pinned")!.name = "Unique target";
      const exact = filterSidebarByText({
        projects: input.projects,
        entries: input.workspaceEntriesByKey,
        projectNames: input.projectNamesByViewKey,
        text: "unique target",
        workspaceTitleSource: "title",
        showBranch: false,
      });
      const projection = buildSidebarProjection({
        ...input,
        projects: exact.projects,
        workspaceEntriesByKey: exact.entries,
      });
      expect(
        projection.pinnedGroups.pinnedChats.map((workspace) => workspace.workspaceKey),
      ).toEqual(["srv:pinned"]);
      expect(exact.entries.has("srv:unpinned")).toBe(false);
      expect(input.projects[0]!.workspaces).toHaveLength(2);
    },
  );
  it("matches before the count window while leaving age and Show more policy effective", () => {
    const rows = Array.from({ length: 31 }, (_, index) =>
      makeWorkspace(index === 30 ? "needle" : `other-${index}`),
    );
    const entries = new Map(rows.map((row) => [row.entry.workspaceKey, row.entry]));
    const source = makeProject(rows.map((row) => row.placement));
    const filtered = filterSidebarByText({
      projects: [source],
      entries,
      projectNames: new Map(),
      text: "needle",
      workspaceTitleSource: "title",
      showBranch: false,
    });
    const matches = filtered.projects[0]!.workspaces;
    expect(
      limitSidebarWorkspaces({ items: matches, initialCount: 20, expanded: false }).visibleItems,
    ).toEqual([rows[30]!.placement]);
    const age = {
      days: 1,
      now: Date.UTC(2026, 9, 16),
      getStatusEnteredAt: () => new Date(Date.UTC(2026, 9, 1)),
    };
    expect(
      limitSidebarWorkspaces({
        items: matches,
        initialCount: 20,
        expanded: false,
        updatedWithin: age,
      }).visibleItems,
    ).toEqual([]);
    expect(
      limitSidebarWorkspaces({
        items: matches,
        initialCount: 20,
        expanded: true,
        updatedWithin: age,
      }).visibleItems,
    ).toEqual(matches);
    expect(source.workspaces).toHaveLength(31);
  });
});

/** A relationship fixture deliberately has no path, branch, title, or runtime activity. */
function treeAgent(
  id: string,
  workspaceId: string,
  parentAgentId: string | null = null,
): WorkspaceTreeAgent {
  return { id, workspaceId, parentAgentId };
}

describe("authoritative workspace parents", () => {
  const workspaces = ["parent", "child", "other", "grandchild"].map(
    (id) => makeWorkspace(id).placement,
  );
  function parents(agents: WorkspaceTreeAgent[], placements = workspaces) {
    return [
      ...resolveWorkspaceParents({
        workspaces: placements,
        sessions: [
          {
            serverId: "srv",
            hasHydratedAgents: true,
            agents: new Map(agents.map((agent) => [agent.id, agent])),
          },
        ],
      }),
    ];
  }

  it("requires all local agents to agree, following same-workspace descendants", () => {
    expect(
      parents([
        treeAgent("p1", "parent"),
        treeAgent("p2", "parent"),
        treeAgent("c1", "child", "p1"),
        treeAgent("c2", "child", "p2"),
        treeAgent("internal", "child", "c1"),
        treeAgent("g", "grandchild", "internal"),
      ]),
    ).toEqual([
      ["srv:child", "srv:parent"],
      ["srv:grandchild", "srv:child"],
    ]);
  });

  it("keeps partial agent directories top-level until the full ownership evidence is hydrated", () => {
    expect([
      ...resolveWorkspaceParents({
        workspaces,
        sessions: [
          {
            serverId: "srv",
            hasHydratedAgents: false,
            agents: new Map([
              ["p", treeAgent("p", "parent")],
              ["c", treeAgent("c", "child", "p")],
            ]),
          },
        ],
      }),
    ]).toEqual([]);
  });

  it("keeps shared, independent and unresolved workspaces top-level", () => {
    const base = [treeAgent("p", "parent"), treeAgent("o", "other"), treeAgent("c", "child", "p")];
    expect(parents([...base, treeAgent("independent", "child")])).toEqual([]);
    expect(parents([...base, treeAgent("shared", "child", "o")])).toEqual([]);
    expect(parents([...base, treeAgent("missing", "child", "absent")])).toEqual([]);
    expect(parents([treeAgent("missing", "child", "absent")])).toEqual([]);
    expect(parents([])).toEqual([]);
  });

  it("ignores archived child agents but refuses archived or invisible parents", () => {
    const archived = new Date("2026-10-22T12:00:00Z");
    expect(
      parents([
        treeAgent("p", "parent"),
        treeAgent("c", "child", "p"),
        { ...treeAgent("old", "child"), archivedAt: archived },
      ]),
    ).toEqual([["srv:child", "srv:parent"]]);
    expect(
      parents([
        { ...treeAgent("p", "parent"), archivedAt: archived },
        treeAgent("c", "child", "p"),
      ]),
    ).toEqual([]);
    expect(
      parents([treeAgent("p", "parent"), treeAgent("c", "child", "p")], [workspaces[1]]),
    ).toEqual([]);
  });

  it("rejects both agent cycles and workspace cycles formed by distinct agents", () => {
    expect(
      parents([treeAgent("c", "child", "internal"), treeAgent("internal", "child", "c")]),
    ).toEqual([]);
    expect(parents([treeAgent("p", "parent", "c"), treeAgent("c", "child", "p")])).toEqual([]);
    expect(
      parents([
        treeAgent("p-root", "parent"),
        treeAgent("c-root", "child"),
        treeAgent("p", "parent", "c-root"),
        treeAgent("c", "child", "p-root"),
      ]),
    ).toEqual([]);
  });

  it("never joins matching agent IDs across servers or unrelated projects", () => {
    expect([
      ...resolveWorkspaceParents({
        workspaces,
        sessions: [
          {
            serverId: "foreign",
            hasHydratedAgents: true,
            agents: new Map([["p", treeAgent("p", "parent")]]),
          },
          {
            serverId: "srv",
            hasHydratedAgents: true,
            agents: new Map([["c", treeAgent("c", "child", "p")]]),
          },
        ],
      }),
    ]).toEqual([]);
    expect(
      parents(
        [treeAgent("p", "parent"), treeAgent("c", "child", "p")],
        [workspaces[0], { ...workspaces[1], projectViewKey: "unrelated" }],
      ),
    ).toEqual([]);
  });
});

function nestedProjectionInput(groupMode: "project" | "status" = "project") {
  const parent = makeWorkspace("parent", "done");
  const child = makeWorkspace("child", "needs_input");
  const grandchild = makeWorkspace("grandchild", "failed");
  const sibling = makeWorkspace("sibling", "running");
  const independent = makeWorkspace("independent", "attention");
  const workspaces = [child, independent, sibling, parent, grandchild];
  return {
    ...projectionInput({ groupMode }),
    projects: [makeProject(workspaces.map((workspace) => workspace.placement))],
    workspaceEntriesByKey: new Map(
      workspaces.map((workspace) => [workspace.entry.workspaceKey, workspace.entry]),
    ),
    workspaceParents: new Map([
      ["srv:child", "srv:parent"],
      ["srv:sibling", "srv:parent"],
      ["srv:grandchild", "srv:child"],
    ]),
    pinnedKeys: { pinnedWorkspaceKeys: [] as string[], pinnedAtByKey: {} },
    workspaceSortMode: "custom" as const,
  };
}

describe("workspace family projection", () => {
  it("keeps sibling order and preorder, with every child represented exactly once", () => {
    const projection = buildSidebarProjection(nestedProjectionInput());
    expect(
      projection.pinnedGroups.unpinnedProjects[0].workspaces.map((row) => row.workspaceId),
    ).toEqual(["independent", "parent", "child", "grandchild", "sibling"]);
    expect(projection.workspaceTree.get("srv:parent")).toEqual({
      parentKey: null,
      childKeys: ["srv:child", "srv:sibling"],
      descendantKeys: ["srv:child", "srv:grandchild", "srv:sibling"],
    });
    expect(projection.shortcutModel.shortcutTargets.map((row) => row.workspaceId)).toEqual([
      "independent",
      "parent",
      "child",
      "grandchild",
      "sibling",
    ]);
  });

  it("moves whole families into the root status bucket without altering raw statuses", () => {
    const input = nestedProjectionInput("status");
    const projection = buildSidebarProjection(input);
    const memberships = [];
    for (const group of projection.workspaceGroups) {
      memberships.push({ key: group.key, ids: group.rows.map((row) => row.workspaceId) });
    }
    expect(memberships).toEqual([
      { key: "attention", ids: ["independent"] },
      { key: "done", ids: ["parent", "child", "grandchild", "sibling"] },
    ]);
    expect(
      projection.workspaceGroups
        .flatMap((group) => group.rows)
        .map((row) => [row.workspaceId, row.statusBucket]),
    ).toEqual([
      ["independent", "attention"],
      ["parent", "done"],
      ["child", "needs_input"],
      ["grandchild", "failed"],
      ["sibling", "running"],
    ]);
  });

  it("preserves global pin boundaries while project-pinned children still follow their parent", () => {
    const input = nestedProjectionInput();
    input.pinnedKeys.pinnedWorkspaceKeys = ["srv:child"];
    input.workspaceEntriesByKey.get("srv:sibling")!.projectPinnedAt = "2026-10-22T12:00:00Z";
    const projection = buildSidebarProjection(input);
    expect(projection.pinnedGroups.pinnedChats.map((row) => row.workspaceId)).toEqual(["child"]);
    expect(
      projection.pinnedGroups.unpinnedProjects[0].workspaces.map((row) => row.workspaceId),
    ).toEqual(["independent", "parent", "sibling", "grandchild"]);
    expect(projection.workspaceTree.get("srv:child")!.parentKey).toBe(null);
    expect(projection.workspaceTree.get("srv:sibling")!.parentKey).toBe("srv:parent");
    expect(projection.workspaceTree.get("srv:grandchild")!.parentKey).toBe(null);
    expect(projection.shortcutModel.shortcutTargets).toHaveLength(5);
  });

  it("keeps a matching child visible at top level when search removes its parent", () => {
    const input = nestedProjectionInput();
    const filtered = filterSidebarByText({
      projects: input.projects,
      entries: input.workspaceEntriesByKey,
      projectNames: input.projectNamesByViewKey,
      text: "child",
      workspaceTitleSource: "title",
      showBranch: false,
    });
    const projection = buildSidebarProjection({
      ...input,
      projects: filtered.projects,
      workspaceEntriesByKey: filtered.entries,
    });
    expect(
      projection.pinnedGroups.unpinnedProjects[0].workspaces.map((row) => row.workspaceId),
    ).toEqual(["child", "grandchild"]);
    expect(projection.workspaceTree.get("srv:child")!.parentKey).toBe(null);
  });

  it("sorts siblings across raw status buckets by their chosen workspace name", () => {
    const input = nestedProjectionInput("status");
    input.workspaceEntriesByKey.get("srv:child")!.name = "Zulu";
    input.workspaceEntriesByKey.get("srv:sibling")!.name = "Alpha";
    const projection = buildSidebarProjection({ ...input, workspaceSortMode: "name" });
    expect(
      projection.workspaceGroups
        .find((group) => group.key === "done")!
        .rows.map((row) => row.workspaceId),
    ).toEqual(["parent", "sibling", "child", "grandchild"]);
  });

  it("nests inside a shared global pin container without duplicating project or status rows", () => {
    const input = nestedProjectionInput("status");
    input.pinnedKeys.pinnedWorkspaceKeys = ["srv:parent", "srv:child", "srv:grandchild"];
    const projection = buildSidebarProjection(input);
    expect(projection.pinnedGroups.pinnedChats.map((row) => row.workspaceId)).toEqual([
      "parent",
      "child",
      "grandchild",
    ]);
    expect(
      projection.workspaceGroups.flatMap((group) => group.rows).map((row) => row.workspaceId),
    ).toEqual(["independent", "sibling"]);
    expect(projection.workspaceTree.get("srv:child")!.parentKey).toBe("srv:parent");
    expect(projection.workspaceTree.get("srv:sibling")!.parentKey).toBe(null);
    expect(projection.shortcutModel.shortcutTargets).toHaveLength(5);
  });

  it("includes rendered nested controls in bulk collapse while preserving hidden preferences", () => {
    const input = nestedProjectionInput();
    const projection = buildSidebarProjection(input);
    const targets = resolveSidebarCollapseTargets({
      projects: input.projects,
      groupMode: "project",
      groupEmptyProjects: false,
      pinnedGroups: projection.pinnedGroups,
      workspaceGroups: projection.workspaceGroups,
      workspaceTree: projection.workspaceTree,
    });
    // Collapse targets are a membership batch; rendered preorder is asserted separately.
    expect(targets.workspaceGroupKeys).toHaveLength(2);
    expect(new Set(targets.workspaceGroupKeys)).toEqual(
      new Set(["workspace:srv:parent", "workspace:srv:child"]),
    );
    const state = {
      collapsedProjectKeys: new Set<string>(),
      collapsedWorkspaceGroupKeys: new Set(["workspace:hidden:parent"]),
      collapsedPinned: false,
    };
    const collapsed = setSectionsCollapsed(state, targets, true);
    expect(collapsed.collapsedWorkspaceGroupKeys).toEqual(
      new Set(["workspace:hidden:parent", "workspace:srv:parent", "workspace:srv:child"]),
    );
    expect(
      setSectionsCollapsed(
        state,
        { ...targets, workspaceGroupKeys: targets.workspaceGroupKeys.toReversed() },
        true,
      ),
    ).toEqual(collapsed);
    expect(setSectionsCollapsed(collapsed, targets, false)).toEqual(state);
  });

  it("keeps the active child family reachable outside the ordinary age window", () => {
    const input = nestedProjectionInput("status");
    const projection = buildSidebarProjection(input);
    const items = buildStatusListItems({
      groups: projection.workspaceGroups,
      workspaceTree: projection.workspaceTree,
      activeWorkspaceKey: "srv:grandchild",
      collapsedGroupKeys: new Set(),
      expandedGroupKeys: new Set(),
      initialCount: 1,
      updatedWithin: { days: 1, now: new Date("2026-10-22T12:00:00Z").getTime() },
    });
    expect(
      items.filter((item) => item.kind === "workspace").map((item) => item.workspace.workspaceId),
    ).toEqual(["parent"]);
  });

  it("prunes collapsed children from keyboard traversal and transiently reveals an active descendant", () => {
    const input = nestedProjectionInput();
    input.collapsedWorkspaceGroupKeys.add(workspaceCollapseKey("srv:parent"));
    input.collapsedWorkspaceGroupKeys.add(workspaceCollapseKey("srv:child"));
    const collapsed = buildSidebarProjection(input);
    expect(collapsed.shortcutModel.shortcutTargets.map((row) => row.workspaceId)).toEqual([
      "independent",
      "parent",
    ]);
    const active = buildSidebarProjection({ ...input, activeWorkspaceKey: "srv:grandchild" });
    expect(active.shortcutModel.shortcutTargets.map((row) => row.workspaceId)).toEqual([
      "independent",
      "parent",
      "child",
      "grandchild",
      "sibling",
    ]);
    expect([...input.collapsedWorkspaceGroupKeys]).toEqual([
      "workspace:srv:parent",
      "workspace:srv:child",
    ]);
    expect(buildSidebarProjection(input).shortcutModel.shortcutTargets).toEqual(
      collapsed.shortcutModel.shortcutTargets,
    );
  });

  it("limits by whole families and admits one when any descendant is recent", () => {
    const input = nestedProjectionInput("status");
    const now = new Date("2026-10-22T12:00:00Z").getTime();
    input.workspaceEntriesByKey.get("srv:grandchild")!.statusEnteredAt = new Date(now);
    const projection = buildSidebarProjection(input);
    const items = buildStatusListItems({
      groups: projection.workspaceGroups,
      workspaceTree: projection.workspaceTree,
      collapsedGroupKeys: new Set(),
      expandedGroupKeys: new Set(),
      initialCount: 1,
      updatedWithin: { days: 1, now },
    });
    expect(
      items.filter((item) => item.kind === "workspace").map((item) => item.workspace.workspaceId),
    ).toEqual(["parent"]);
    expect(
      items.filter((item) => item.kind === "header").map((item) => item.group.rows.length),
    ).toEqual([1, 4]);
    expect(projection.workspaceGroups[1].rows.map((row) => row.workspaceId)).toEqual([
      "parent",
      "child",
      "grandchild",
      "sibling",
    ]);
    const expanded = buildStatusListItems({
      groups: projection.workspaceGroups,
      workspaceTree: projection.workspaceTree,
      collapsedGroupKeys: new Set(),
      expandedGroupKeys: new Set(["attention", "done"]),
      initialCount: 1,
      updatedWithin: { days: 1, now },
    });
    expect(
      expanded
        .filter((item) => item.kind === "workspace")
        .map((item) => item.workspace.workspaceId),
    ).toEqual(["independent", "parent"]);
  });

  it("separates passive child status from explicit human attention, even when collapsed", () => {
    const input = nestedProjectionInput();
    const projection = buildSidebarProjection(input);
    const node = projection.workspaceTree.get("srv:parent")!;
    expect(
      summarizeWorkspaceChildren({
        node,
        entries: input.workspaceEntriesByKey,
        humanAttentionWorkspaceKeys: new Set(),
      }),
    ).toEqual({ count: 3, bucket: "needs_input", humanAttentionCount: 0 });
    expect(
      summarizeWorkspaceChildren({
        node,
        entries: input.workspaceEntriesByKey,
        humanAttentionWorkspaceKeys: new Set(["srv:grandchild"]),
      }),
    ).toEqual({ count: 3, bucket: "needs_input", humanAttentionCount: 1 });
    expect(input.workspaceEntriesByKey.get("srv:parent")!.statusBucket).toBe("done");
  });

  it("keeps descendant order within its parent after root or child sibling reorders", () => {
    const input = nestedProjectionInput();
    const placements = input.projects[0].workspaces;
    const byId = new Map(placements.map((workspace) => [workspace.workspaceId, workspace]));
    const reorder = (ids: string[]) =>
      orderWorkspaceFamilies({
        workspaces: ids.map((id) => byId.get(id)!),
        parents: input.workspaceParents,
      }).rows.map((row) => row.workspaceId);
    expect(reorder(["parent", "independent", "child", "sibling", "grandchild"])).toEqual([
      "parent",
      "child",
      "grandchild",
      "sibling",
      "independent",
    ]);
    expect(reorder(["sibling", "child", "independent", "parent", "grandchild"])).toEqual([
      "independent",
      "parent",
      "sibling",
      "child",
      "grandchild",
    ]);
  });
});

interface AttentionAgentFixture extends WorkspaceAttentionAgent {
  parentAgentId: string | null;
}

function attentionAgent(input: Partial<AttentionAgentFixture> = {}): AttentionAgentFixture {
  return {
    workspaceId: "child",
    status: "idle",
    pendingPermissions: [],
    parentAgentId: "parent-agent",
    ...input,
  };
}

describe("child workspace human-attention adapter", () => {
  it("uses the accepted shared audience decision for every child, independently of raw blocker status", () => {
    const input = nestedProjectionInput();
    const agents = new Map([
      [
        "passive-blocker",
        attentionAgent({ status: "error", requiresAttention: true, humanAttentionRequired: false }),
      ],
      [
        "explicit-escalation",
        attentionAgent({ workspaceId: "grandchild", humanAttentionRequired: true }),
      ],
      [
        "archived",
        attentionAgent({
          workspaceId: "sibling",
          humanAttentionRequired: true,
          archivedAt: new Date("2026-10-22T12:00:00Z"),
        }),
      ],
      ["invisible", attentionAgent({ workspaceId: "invisible", humanAttentionRequired: true })],
    ]);
    const keys = buildWorkspaceHumanAttentionKeys({
      workspaces: input.projects[0].workspaces,
      sessions: { srv: { agents } },
    });
    expect([...keys]).toEqual(["srv:grandchild"]);
    const projection = buildSidebarProjection(input);
    expect(
      summarizeWorkspaceChildren({
        node: projection.workspaceTree.get("srv:parent")!,
        entries: input.workspaceEntriesByKey,
        humanAttentionWorkspaceKeys: keys,
      }),
    ).toEqual({ count: 3, bucket: "needs_input", humanAttentionCount: 1 });
    expect(input.workspaceEntriesByKey.get("srv:parent")!.statusBucket).toBe("done");
  });

  it("preserves the shared helper's older-host error, attention and permission behavior", () => {
    const input = nestedProjectionInput();
    const agents = new Map([
      ["error", attentionAgent({ status: "error" })],
      ["attention", attentionAgent({ workspaceId: "grandchild", requiresAttention: true })],
      [
        "permission",
        attentionAgent({
          workspaceId: "sibling",
          pendingPermissions: [
            { id: "p", provider: "codex", name: "shell", kind: "tool", input: {} },
          ],
        }),
      ],
    ]);
    expect([
      ...buildWorkspaceHumanAttentionKeys({
        workspaces: input.projects[0].workspaces,
        sessions: { srv: { agents } },
      }),
    ]).toEqual(["srv:child", "srv:grandchild", "srv:sibling"]);
  });

  it("keeps identical IDs scoped to their server and retains stable results for unrelated changes", () => {
    const child = makeWorkspace("child").placement;
    const foreign = { ...child, serverId: "foreign", workspaceKey: "foreign:child" };
    const select = createWorkspaceHumanAttentionSelector([child, foreign]);
    const agents = new Map([["same-agent-id", attentionAgent({ humanAttentionRequired: false })]]);
    const foreignAgents = new Map([
      ["same-agent-id", attentionAgent({ humanAttentionRequired: true })],
    ]);
    const first = select({ srv: { agents }, foreign: { agents: foreignAgents } });
    expect([...first]).toEqual(["foreign:child"]);
    expect(select({ srv: { agents }, foreign: { agents: foreignAgents } })).toBe(first);
    const nextAgents = new Map(agents);
    nextAgents.set("unrelated", attentionAgent({ workspaceId: "invisible" }));
    expect(select({ srv: { agents: nextAgents }, foreign: { agents: foreignAgents } })).toBe(first);
    const quietForeign = new Map([
      ["same-agent-id", attentionAgent({ humanAttentionRequired: false })],
    ]);
    expect([...select({ srv: { agents }, foreign: { agents: quietForeign } })]).toEqual([]);
  });
});

/** Keep descriptor omission distinct from the current daemon's explicit false projection. */
function attentionWorkspace(
  input: Partial<WorkspaceDescriptor> & Pick<WorkspaceDescriptor, "id">,
): WorkspaceDescriptor {
  return {
    projectId: "project",
    projectDisplayName: "Project",
    projectRootPath: "/repo",
    workspaceDirectory: `/repo/${input.id}`,
    projectKind: "git",
    workspaceKind: "worktree",
    name: input.id,
    status: "done",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
    ...input,
  };
}

describe("child workspace authoritative attention", () => {
  it("T53 workspace authority suppresses routine raw blockers", () => {
    const input = nestedProjectionInput();
    const agents = new Map([
      ["error", attentionAgent({ status: "error" })],
      ["unread", attentionAgent({ workspaceId: "grandchild", requiresAttention: true })],
      [
        "permission",
        attentionAgent({
          workspaceId: "sibling",
          pendingPermissions: [
            { id: "p", provider: "codex", name: "shell", kind: "tool", input: {} },
          ],
        }),
      ],
    ]);
    const workspaces = new Map([
      ["child", attentionWorkspace({ id: "child", humanAttentionRequired: false })],
      ["grandchild", attentionWorkspace({ id: "grandchild", humanAttentionRequired: false })],
      ["sibling", attentionWorkspace({ id: "sibling", humanAttentionRequired: false })],
    ]);
    const sessions = { srv: { agents, workspaces } };
    const keys = buildWorkspaceHumanAttentionKeys({
      workspaces: input.projects[0].workspaces,
      sessions,
    });
    expect(keys).toEqual(new Set());
    const projection = buildSidebarProjection(input);
    expect(
      summarizeWorkspaceChildren({
        node: projection.workspaceTree.get("srv:parent")!,
        entries: input.workspaceEntriesByKey,
        humanAttentionWorkspaceKeys: keys,
      }),
    ).toEqual({ count: 3, bucket: "needs_input", humanAttentionCount: 0 });
    expect(input.workspaceEntriesByKey.get("srv:parent")!.statusBucket).toBe("done");
  });

  it("T53 workspace authority counts interventions and terminal attention once", () => {
    const input = nestedProjectionInput();
    const agents = new Map([
      ["explicit-child", attentionAgent({ humanAttentionRequired: true })],
      ["same-workspace", attentionAgent({ humanAttentionRequired: true })],
      [
        "archived",
        attentionAgent({
          workspaceId: "sibling",
          humanAttentionRequired: true,
          archivedAt: new Date("2026-10-22T12:00:00Z"),
        }),
      ],
      ["invisible", attentionAgent({ workspaceId: "invisible", humanAttentionRequired: true })],
    ]);
    const workspaces = new Map([
      // Canonical descriptor identity wins even when an existing cache uses a different map key.
      ["cached-child-key", attentionWorkspace({ id: "child", humanAttentionRequired: true })],
      // Terminal attention has no corresponding agent and must still count this workspace.
      ["grandchild", attentionWorkspace({ id: "grandchild", humanAttentionRequired: true })],
      ["sibling", attentionWorkspace({ id: "sibling", humanAttentionRequired: false })],
      ["parent", attentionWorkspace({ id: "parent", humanAttentionRequired: true })],
      ["invisible", attentionWorkspace({ id: "invisible", humanAttentionRequired: true })],
    ]);
    const sessions = { srv: { agents, workspaces } };
    const keys = buildWorkspaceHumanAttentionKeys({
      workspaces: input.projects[0].workspaces,
      sessions,
    });
    expect(keys).toEqual(new Set(["srv:parent", "srv:child", "srv:grandchild"]));
    const projection = buildSidebarProjection(input);
    expect(
      summarizeWorkspaceChildren({
        node: projection.workspaceTree.get("srv:parent")!,
        entries: input.workspaceEntriesByKey,
        humanAttentionWorkspaceKeys: keys,
      }),
    ).toEqual({ count: 3, bucket: "needs_input", humanAttentionCount: 2 });
  });

  it("T53 workspace authority preserves undefined older-host fallbacks", () => {
    const input = nestedProjectionInput();
    const agents = new Map([
      ["error", attentionAgent({ status: "error" })],
      ["unread", attentionAgent({ workspaceId: "grandchild", requiresAttention: true })],
      [
        "permission",
        attentionAgent({
          workspaceId: "sibling",
          pendingPermissions: [
            { id: "p", provider: "codex", name: "shell", kind: "tool", input: {} },
          ],
        }),
      ],
    ]);
    const workspaces = new Map([
      ["child", attentionWorkspace({ id: "child" })],
      ["grandchild", attentionWorkspace({ id: "grandchild", humanAttentionRequired: undefined })],
    ]);
    const sessions = { srv: { agents, workspaces } };
    expect(
      buildWorkspaceHumanAttentionKeys({ workspaces: input.projects[0].workspaces, sessions }),
    ).toEqual(new Set(["srv:child", "srv:grandchild", "srv:sibling"]));
  });

  it("T53 workspace authority invalidates workspace-only cache changes within each host", () => {
    const child = makeWorkspace("child").placement;
    const foreign = { ...child, serverId: "foreign", workspaceKey: "foreign:child" };
    const select = createWorkspaceHumanAttentionSelector([child, foreign]);
    const agents = new Map([["same-agent-id", attentionAgent({ status: "error" })]]);
    const foreignAgents = new Map(agents);
    const quiet = new Map([
      ["child", attentionWorkspace({ id: "child", humanAttentionRequired: false })],
    ]);
    const foreignQuiet = new Map(quiet);
    const sessions = {
      srv: { agents, workspaces: quiet },
      foreign: { agents: foreignAgents, workspaces: foreignQuiet },
    };
    const first = select(sessions);
    expect(first).toEqual(new Set());
    expect(select(sessions)).toBe(first);

    const active = new Map([
      ["child", attentionWorkspace({ id: "child", humanAttentionRequired: true })],
    ]);
    const activeSessions = { ...sessions, srv: { agents, workspaces: active } };
    const second = select(activeSessions);
    expect(second).toEqual(new Set(["srv:child"]));
    expect(select({ ...activeSessions, srv: { agents, workspaces: new Map(active) } })).toBe(
      second,
    );
    const quietAgain = select(sessions);
    expect(quietAgain).toEqual(new Set());
    expect(select({ ...sessions, srv: { agents, workspaces: new Map(quiet) } })).toBe(quietAgain);

    const omitted = new Map([["child", attentionWorkspace({ id: "child" })]]);
    const olderSessions = { ...sessions, srv: { agents, workspaces: omitted } };
    const fallback = select(olderSessions);
    expect(fallback).toEqual(new Set(["srv:child"]));
    const unrelatedAgents = new Map(agents);
    unrelatedAgents.set("invisible", attentionAgent({ workspaceId: "invisible" }));
    expect(
      select({ ...olderSessions, srv: { agents: unrelatedAgents, workspaces: omitted } }),
    ).toBe(fallback);
    const foreignActive = {
      ...olderSessions,
      foreign: { agents: foreignAgents, workspaces: active },
    };
    expect(select(foreignActive)).toEqual(new Set(["srv:child", "foreign:child"]));
    const quietAgents = new Map([
      ["same-agent-id", attentionAgent({ humanAttentionRequired: false })],
    ]);
    expect(select({ ...foreignActive, srv: { agents: quietAgents, workspaces: omitted } })).toEqual(
      new Set(["foreign:child"]),
    );
  });
});
