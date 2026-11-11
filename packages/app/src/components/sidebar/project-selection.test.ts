import { describe, expect, test } from "vitest";
import { resolveActiveProjectFilters } from "./sidebar-project-filter";
import { includeCreatedProjectFilter } from "./project-selection";

describe("includeCreatedProjectFilter", () => {
  const projects = [
    {
      viewKey: "alpha",
      hosts: [
        {
          serverId: "home",
          projectId: "old",
          iconWorkingDir: "/old",
          worktreeSupport: "supported" as const,
        },
      ],
    },
    {
      viewKey: "new-shared-key",
      hosts: [
        {
          serverId: "home",
          projectId: "new",
          iconWorkingDir: "/new",
          worktreeSupport: "supported" as const,
        },
      ],
    },
    {
      viewKey: '["remote","new"]',
      hosts: [
        {
          serverId: "remote",
          projectId: "new",
          iconWorkingDir: "/remote",
          worktreeSupport: "supported" as const,
        },
      ],
    },
  ];

  test("appends the created project's actual view key and preserves existing and offline choices", () => {
    const result = includeCreatedProjectFilter({
      projectFilters: ["alpha", "offline"],
      projects,
      serverId: "home",
      projectId: "new",
    });
    expect(result).toEqual(["alpha", "offline", "new-shared-key"]);
    expect(
      resolveActiveProjectFilters(result, new Set(projects.map((project) => project.viewKey))),
    ).toEqual(["alpha", "new-shared-key"]);
  });

  test("uses the host-specific placement when project IDs collide", () => {
    expect(
      includeCreatedProjectFilter({
        projectFilters: ["alpha"],
        projects,
        serverId: "remote",
        projectId: "new",
      }),
    ).toEqual(["alpha", '["remote","new"]']);
  });

  test.each([{ projectFilters: [] }, { projectFilters: ["offline"] }])(
    "preserves the all-projects view for stored selection $projectFilters",
    ({ projectFilters }) => {
      expect(
        includeCreatedProjectFilter({
          projectFilters,
          projects,
          serverId: "home",
          projectId: "new",
        }),
      ).toBe(projectFilters);
    },
  );

  test("does not toggle an already visible project off", () => {
    const projectFilters = ["alpha", "new-shared-key"];
    expect(
      includeCreatedProjectFilter({ projectFilters, projects, serverId: "home", projectId: "new" }),
    ).toBe(projectFilters);
  });

  test("leaves projects outside the current host projection unchanged", () => {
    const projectFilters = ["alpha"];
    expect(
      includeCreatedProjectFilter({
        projectFilters,
        projects: projects.slice(0, 1),
        serverId: "remote",
        projectId: "new",
      }),
    ).toBe(projectFilters);
  });
});
