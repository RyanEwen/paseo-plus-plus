import { describe, expect, it } from "vitest";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import type { HostRuntimeConnectionStatus } from "@/runtime/host-runtime";
import { summarizeSidebarProjectActivity } from "./sidebar-project-activity";

const ONLINE = new Map<string, HostRuntimeConnectionStatus>([["srv", "online"]]);

function makeWorkspace(id: string, statusBucket: SidebarWorkspaceEntry["statusBucket"]) {
  const placement: SidebarWorkspacePlacement = {
    workspaceKey: `srv:${id}`,
    serverId: "srv",
    workspaceId: id,
    projectViewKey: "project",
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
    labels: [],
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

function entriesOf(
  ...workspaces: { entry: SidebarWorkspaceEntry }[]
): Map<string, SidebarWorkspaceEntry> {
  return new Map(workspaces.map(({ entry }) => [entry.workspaceKey, entry]));
}

describe("summarizeSidebarProjectActivity", () => {
  it("surfaces ready work ahead of a working sibling while counting the working workspace", () => {
    const working = makeWorkspace("working", "running");
    const ready = makeWorkspace("ready", "attention");
    const project = makeProject([working.placement, ready.placement]);

    expect(
      summarizeSidebarProjectActivity([project], entriesOf(working, ready), ONLINE).get("project"),
    ).toEqual({ bucket: "attention", workingCount: 1 });

    ready.entry.statusBucket = "done";
    expect(
      summarizeSidebarProjectActivity([project], entriesOf(working, ready), ONLINE).get("project"),
    ).toEqual({ bucket: "running", workingCount: 1 });
  });

  it("keeps needs-input ahead of working while counting the working workspace", () => {
    const first = makeWorkspace("first", "running");
    const second = makeWorkspace("second", "needs_input");
    const project = makeProject([first.placement, second.placement]);

    expect(
      summarizeSidebarProjectActivity([project], entriesOf(first, second), ONLINE).get("project"),
    ).toEqual({ bucket: "needs_input", workingCount: 1 });
  });

  it("suppresses stale offline activity and avoids marking unknown or empty projects done", () => {
    const worker = makeWorkspace("worker", "running");
    const project = makeProject([worker.placement]);
    const empty = makeProject([], "empty");
    const offline = new Map<string, HostRuntimeConnectionStatus>([["srv", "offline"]]);

    expect(
      summarizeSidebarProjectActivity([project], entriesOf(worker), offline).get("project"),
    ).toEqual({ bucket: null, workingCount: 0 });
    expect(summarizeSidebarProjectActivity([project], new Map(), ONLINE).get("project")).toEqual({
      bucket: null,
      workingCount: 0,
    });
    expect(summarizeSidebarProjectActivity([empty], entriesOf(worker), ONLINE).get("empty")).toEqual(
      { bucket: null, workingCount: 0 },
    );
  });
});
