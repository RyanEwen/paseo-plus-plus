import { describe, expect, test } from "vitest";
import type { WorkspaceStructureHostPlacement } from "@/projects/workspace-structure";
import { resolveProjectIconTargets } from "./project-selector-model";

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
