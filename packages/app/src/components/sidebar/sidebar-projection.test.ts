import {
  buildWorkspaceHumanAttentionKeys,
  createWorkspaceHumanAttentionSelector,
  type WorkspaceAttentionAgent,
} from "./workspace-tree-attention";
import {
  orderWorkspaceFamilies,
  collectActiveWorkspaceKeys,
  includeActiveWorkspaceFamily,
  resolveWorkspaceParents,
  summarizeWorkspaceChildren,
  workspaceCollapseKey,
  type WorkspaceTreeAgent,
} from "./workspace-tree";
import { filterSidebarByText } from "./sidebar-text-filter";
import { limitSidebarWorkspaces } from "./workspace-limit";
import { summarizeSidebarProjectActivity } from "./sidebar-project-activity";
import { i18n } from "@/i18n/i18next";
import { describe, expect, it } from "vitest";
import { resolveProjectWorkspaceReorder } from "@/utils/sidebar-reorder";
import { applyStoredOrdering } from "@/hooks/sidebar-workspaces-view-model";
import { reorderItemsWithMove } from "@/components/drag-reorder/reorder-items";
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
import { buildSidebarProjection } from "./sidebar-projection";
import { resolveSidebarCollapseTargets } from "./bulk-collapse-targets";
import { buildStatusListItems } from "./status-list-items";
import { setSectionsCollapsed } from "@/stores/sidebar-collapsed-sections-store/state";
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
  it("active descendants retain their whole family beyond a window without moving passive siblings or pin partitions", () => {
    const rows = [
      makeWorkspace("first"),
      makeWorkspace("hidden"),
      makeWorkspace("parent"),
      makeWorkspace("child", "running"),
      makeWorkspace("selected"),
      makeWorkspace("selected-child"),
    ];
    const entries = new Map(rows.map((row) => [row.entry.workspaceKey, row.entry]));
    const family = orderWorkspaceFamilies({
      workspaces: rows.map((row) => row.placement),
      parents: new Map([
        ["srv:child", "srv:parent"],
        ["srv:selected-child", "srv:selected"],
      ]),
    });
    const roots = family.rows.filter((row) => !family.tree.get(row.workspaceKey)?.parentKey);
    const rendered = includeActiveWorkspaceFamily({
      roots,
      visibleItems: roots.slice(0, 1),
      tree: family.tree,
      activeWorkspaceKey: "srv:selected-child",
      activeWorkspaceKeys: collectActiveWorkspaceKeys(entries),
    });
    expect(rendered.map((row) => row.workspaceKey)).toEqual([
      "srv:first",
      "srv:parent",
      "srv:selected",
    ]);
    expect(family.tree.get("srv:parent")?.descendantKeys).toEqual(["srv:child"]);
    expect(family.rows.map((row) => row.workspaceKey)).toEqual(
      rows.map((row) => row.placement.workspaceKey),
    );
    // An independently pinned child is a separate family and cannot expose the ordinary parent.
    const separated = orderWorkspaceFamilies({
      workspaces: [rows[3]!.placement],
      parents: new Map([["srv:child", "srv:parent"]]),
    });
    expect(
      includeActiveWorkspaceFamily({
        roots: separated.rows,
        visibleItems: [],
        tree: separated.tree,
        activeWorkspaceKey: null,
        activeWorkspaceKeys: collectActiveWorkspaceKeys(entries),
      }).map((row) => row.workspaceKey),
    ).toEqual(["srv:child"]);
    const doneEntries = new Map(entries);
    doneEntries.set("srv:child", { ...rows[3]!.entry, statusBucket: "done" });
    expect(
      includeActiveWorkspaceFamily({
        roots,
        visibleItems: roots.slice(0, 1),
        tree: family.tree,
        activeWorkspaceKey: null,
        activeWorkspaceKeys: collectActiveWorkspaceKeys(doneEntries),
      }).map((row) => row.workspaceKey),
    ).toEqual(["srv:first"]);
  });

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

  it("keeps the selected child family reachable outside the ordinary age window", () => {
    const input = nestedProjectionInput("status");
    const now = new Date("2026-10-22T12:00:00Z").getTime();
    // Inactive old families isolate selection from the active-work exemption.
    for (const entry of input.workspaceEntriesByKey.values()) {
      entry.statusBucket = "done";
      entry.statusEnteredAt = new Date(now - 2 * 86_400_000);
    }
    const projection = buildSidebarProjection(input);
    const listOptions = {
      groups: projection.workspaceGroups,
      workspaceTree: projection.workspaceTree,
      collapsedGroupKeys: new Set<string>(),
      expandedGroupKeys: new Set<string>(),
      initialCount: 1,
      updatedWithin: { days: 1, now },
    };
    const withoutSelection = buildStatusListItems(listOptions);
    expect(
      withoutSelection
        .filter((item) => item.kind === "workspace")
        .map((item) => item.workspace.workspaceId),
    ).toEqual([]);
    const items = buildStatusListItems({
      ...listOptions,
      activeWorkspaceKey: "srv:grandchild",
    });
    expect(
      items.filter((item) => item.kind === "workspace").map((item) => item.workspace.workspaceId),
    ).toEqual(["parent"]);
    const headers = items.filter((item) => item.kind === "header");
    expect(headers.map((item) => item.group.key)).toEqual(["done"]);
    expect(headers[0]!.group.rows.map((row) => row.workspaceId)).toEqual([
      "independent",
      "parent",
      "child",
      "grandchild",
      "sibling",
    ]);
    expect(projection.workspaceTree.get("srv:parent")).toEqual({
      parentKey: null,
      childKeys: ["srv:child", "srv:sibling"],
      descendantKeys: ["srv:child", "srv:grandchild", "srv:sibling"],
    });
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
    // Every family starts inactive and old so only descendant recency can admit it.
    for (const entry of input.workspaceEntriesByKey.values()) {
      entry.statusBucket = "done";
      entry.statusEnteredAt = new Date(now - 2 * 86_400_000);
    }
    const oldProjection = buildSidebarProjection(input);
    const oldItems = buildStatusListItems({
      groups: oldProjection.workspaceGroups,
      workspaceTree: oldProjection.workspaceTree,
      collapsedGroupKeys: new Set(),
      expandedGroupKeys: new Set(),
      initialCount: 1,
      updatedWithin: { days: 1, now },
    });
    expect(
      oldItems
        .filter((item) => item.kind === "workspace")
        .map((item) => item.workspace.workspaceId),
    ).toEqual([]);
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
    ).toEqual([5]);
    expect(projection.workspaceGroups.map((group) => group.key)).toEqual(["done"]);
    expect(projection.workspaceGroups[0].rows.map((row) => row.workspaceId)).toEqual([
      "independent",
      "parent",
      "child",
      "grandchild",
      "sibling",
    ]);
    expect(projection.workspaceTree.get("srv:parent")).toEqual({
      parentKey: null,
      childKeys: ["srv:child", "srv:sibling"],
      descendantKeys: ["srv:child", "srv:grandchild", "srv:sibling"],
    });
    const expanded = buildStatusListItems({
      groups: projection.workspaceGroups,
      workspaceTree: projection.workspaceTree,
      collapsedGroupKeys: new Set(),
      expandedGroupKeys: new Set(["done"]),
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
    createdAt: null,
    lastUserMessageAt: null,
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
  it("workspace authority suppresses routine raw blockers", () => {
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

  it("workspace authority counts interventions and terminal attention once", () => {
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

  it("workspace authority preserves undefined older-host fallbacks", () => {
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

  it("workspace authority invalidates workspace-only cache changes within each host", () => {
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

describe("anchored project workspace drag projection", () => {
  it("uses real pinned child indices without moving the parent or passive siblings", () => {
    const parent = makeWorkspace("parent");
    const a = makeWorkspace("a");
    const b = makeWorkspace("b");
    const childPin = makeWorkspace("child-pin");
    const rootPin = makeWorkspace("root-pin");
    const outside = makeWorkspace("outside");
    childPin.entry.projectPinnedAt = "2026-10-22T12:00:00.000Z";
    rootPin.entry.projectPinnedAt = "2026-10-22T12:00:00.000Z";
    const all = [parent, a, b, childPin, rootPin, outside];
    const input = {
      ...projectionInput(),
      projects: [makeProject(all.map((workspace) => workspace.placement))],
      pinnedKeys: { pinnedWorkspaceKeys: [], pinnedAtByKey: {} },
      pinnedWorkspaceOrder: ["srv:root-pin", "srv:child-pin"],
      workspaceEntriesByKey: new Map(all.map(({ entry }) => [entry.workspaceKey, entry])),
      workspaceParents: new Map(
        [a, b, childPin].map(({ placement }) => [placement.workspaceKey, "srv:parent"]),
      ),
    };
    const projection = buildSidebarProjection(input);
    const project = projection.pinnedGroups.unpinnedProjects[0];
    if (!project) throw new Error("Actual project projection missing");
    const keys = project.workspaces.map((row) => row.workspaceKey);
    expect(keys).toEqual([
      "srv:root-pin",
      "srv:parent",
      "srv:child-pin",
      "srv:a",
      "srv:b",
      "srv:outside",
    ]);
    const childKeys = projection.workspaceTree.get("srv:parent")?.childKeys;
    expect(childKeys).toEqual(["srv:child-pin", "srv:a", "srv:b"]);
    const children = project.workspaces.filter((row) => childKeys?.includes(row.workspaceKey));
    expect(children.map((row) => row.workspaceKey)).toEqual(childKeys);
    const pins = new Set(["srv:root-pin", "srv:child-pin"]);
    const move = reorderItemsWithMove({
      items: children,
      activeId: "srv:a",
      overId: "srv:b",
      keyExtractor: (row) => row.workspaceKey,
      getDragGroupKey: (row) => (pins.has(row.workspaceKey) ? "pins" : "ordinary"),
    });
    expect(move?.move).toEqual({ activeKey: "srv:a", overKey: "srv:b", from: 1, to: 2 });
    if (!move) throw new Error("Actual sibling drag was not admitted");
    const saved = all.map(({ placement }) => placement.workspaceKey);
    const result = resolveProjectWorkspaceReorder({
      currentVisibleKeys: keys,
      reorderedVisibleKeys: move.items.map((row) => row.workspaceKey),
      projectPinnedKeys: pins,
      storedWorkspaceOrder: saved,
      move: move.move,
    });
    expect(result).toEqual({
      pinOrder: null,
      workspaceOrder: [
        "srv:parent",
        "srv:b",
        "srv:a",
        "srv:child-pin",
        "srv:root-pin",
        "srv:outside",
      ],
    });
    if (!result.workspaceOrder) throw new Error("Actual sibling drag did not return an order");
    const reprojected = buildSidebarProjection({
      ...input,
      projects: [
        makeProject(
          applyStoredOrdering({
            items: input.projects[0]!.workspaces,
            storedOrder: result.workspaceOrder,
            getKey: (row) => row.workspaceKey,
          }),
        ),
      ],
    });
    expect(reprojected.workspaceTree.get("srv:parent")?.childKeys).toEqual([
      "srv:child-pin",
      "srv:b",
      "srv:a",
    ]);
    expect(reprojected.workspaceTree.get("srv:a")?.parentKey).toBe("srv:parent");
    expect(
      reprojected.pinnedGroups.unpinnedProjects[0]?.workspaces.map((row) => row.workspaceKey),
    ).toEqual(["srv:root-pin", "srv:parent", "srv:child-pin", "srv:b", "srv:a", "srv:outside"]);
    expect(saved).toEqual(all.map(({ placement }) => placement.workspaceKey));
  });
});
