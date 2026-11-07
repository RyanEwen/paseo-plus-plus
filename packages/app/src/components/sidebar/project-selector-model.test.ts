import { beforeAll, describe, expect, test } from "vitest";
import { i18n } from "@/i18n/i18next";
import type { WorkspaceStructureHostPlacement } from "@/projects/workspace-structure";
import {
  hostBranchIsActive,
  projectsOnVisibleHosts,
  resolveProjectIconTargets,
  resolveSelectorHeading,
  showsAllWorkspaces,
} from "./project-selector-model";

function placement(
  overrides: Partial<WorkspaceStructureHostPlacement> = {},
): WorkspaceStructureHostPlacement {
  return {
    serverId: "home",
    projectId: "alpha",
    iconWorkingDir: "/repo/alpha",
    worktreeSupport: "supported",
    ...overrides,
  };
}

describe("resolveProjectIconTargets", () => {
  test("requests each project's icon from its first usable placement", () => {
    expect(
      resolveProjectIconTargets([
        {
          viewKey: "alpha",
          hosts: [
            placement({ serverId: "", iconWorkingDir: "/ignored" }),
            placement({ serverId: "wsl", iconWorkingDir: " /repo/alpha ", iconRevision: "r1" }),
          ],
        },
      ]),
    ).toEqual([
      {
        projectViewKey: "alpha",
        serverId: "wsl",
        projectId: "alpha",
        iconWorkingDir: "/repo/alpha",
        customIconRevision: undefined,
        iconRevision: "r1",
      },
    ]);
  });

  test("skips projects without a usable placement", () => {
    expect(
      resolveProjectIconTargets([
        { viewKey: "blank", hosts: [placement({ iconWorkingDir: "  " })] },
        { viewKey: "no-id", hosts: [placement({ projectId: "" })] },
        { viewKey: "none", hosts: [] },
      ]),
    ).toEqual([]);
  });
});

describe("resolveSelectorHeading", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  const labels = new Map([
    ["alpha", "Alpha"],
    ["beta", "Beta"],
  ]);

  test("names all workspaces without an applied project filter", () => {
    expect(resolveSelectorHeading(i18n.t, [], labels)).toBe("All Workspaces");
  });

  test("names the one selected project by its chooser label", () => {
    expect(resolveSelectorHeading(i18n.t, ["beta"], labels)).toBe("Beta Workspaces");
  });

  test("counts several selected projects", () => {
    expect(resolveSelectorHeading(i18n.t, ["alpha", "beta"], labels)).toBe(
      "2 Projects\u2019 Workspaces",
    );
  });
});

describe("showsAllWorkspaces", () => {
  test("is checked with no project filter and no host filter", () => {
    expect(
      showsAllWorkspaces({ resolvedProjectFilters: [], hostFilters: [], serverIds: ["home"] }),
    ).toBe(true);
  });

  test("stays checked when the host filter names only unregistered hosts", () => {
    expect(
      showsAllWorkspaces({
        resolvedProjectFilters: [],
        hostFilters: ["retired"],
        serverIds: ["home"],
      }),
    ).toBe(true);
  });

  test("is unchecked while a registered host or a project is selected", () => {
    expect(
      showsAllWorkspaces({ resolvedProjectFilters: [], hostFilters: ["home"], serverIds: ["home"] }),
    ).toBe(false);
    expect(
      showsAllWorkspaces({ resolvedProjectFilters: ["alpha"], hostFilters: [], serverIds: ["home"] }),
    ).toBe(false);
  });
});

describe("projectsOnVisibleHosts", () => {
  const home = { viewKey: "home-only", hosts: [placement({ serverId: "home" })] };
  const wsl = { viewKey: "wsl-only", hosts: [placement({ serverId: "wsl" })] };

  test("lists every project without a host filter", () => {
    expect(projectsOnVisibleHosts([home, wsl], [])).toEqual([home, wsl]);
  });

  test("keeps projects placed on a selected host", () => {
    expect(projectsOnVisibleHosts([home, wsl], ["wsl"])).toEqual([wsl]);
  });
});

describe("hostBranchIsActive", () => {
  test("marks the Hosts branch while a host is selected", () => {
    expect(hostBranchIsActive({ hostFilters: ["home"] })).toBe(true);
  });

  test("leaves the Hosts branch unmarked with no filters", () => {
    expect(hostBranchIsActive({ hostFilters: [] })).toBe(false);
  });

  test("leaves the Hosts branch unmarked when only a project is selected", () => {
    // The stored local filters, as the selector reads them from the sidebar view store.
    const stored = { hostFilters: [], projectFilters: ["alpha"] };
    expect(hostBranchIsActive(stored)).toBe(false);
  });
});
