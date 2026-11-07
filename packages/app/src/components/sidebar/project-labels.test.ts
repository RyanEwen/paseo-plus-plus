import { describe, expect, test } from "vitest";
import { resolveSidebarProjectLabels, type LabelledProject } from "./project-labels";

describe("resolveSidebarProjectLabels", () => {
  function project(
    viewKey: string,
    projectName: string,
    serverId: string,
    path = "/repo",
  ): LabelledProject {
    return {
      viewKey,
      projectName,
      iconWorkingDir: path,
      hosts: [{ serverId, projectId: viewKey, iconWorkingDir: path, worktreeSupport: "supported" }],
    };
  }
  const hosts = [
    { serverId: "home", label: "Home" },
    { serverId: "wsl", label: "WSL" },
  ];

  test("leaves unique names alone and keeps project IDs separate from labels", () => {
    expect([...resolveSidebarProjectLabels([project("id", "PrintStream", "home")], hosts)]).toEqual(
      [["id", "PrintStream"]],
    );
  });

  test("qualifies duplicate project names with host names", () => {
    expect([
      ...resolveSidebarProjectLabels(
        [project("one", "PrintStream", "home"), project("two", "PrintStream", "wsl")],
        hosts,
      ),
    ]).toEqual([
      ["one", "PrintStream (Home)"],
      ["two", "PrintStream (WSL)"],
    ]);
  });

  test("uses paths when names also collide on the same host", () => {
    expect([
      ...resolveSidebarProjectLabels(
        [
          project("one", "PrintStream", "home", "/repo/one"),
          project("two", "PrintStream", "home", "/repo/two"),
        ],
        hosts,
      ),
    ]).toEqual([
      ["one", "PrintStream (Home) (/repo/one)"],
      ["two", "PrintStream (Home) (/repo/two)"],
    ]);
  });

  test("uses stable host identity when a host has no display name", () => {
    expect([
      ...resolveSidebarProjectLabels(
        [project("one", "PrintStream", "home"), project("two", "PrintStream", "wsl")],
        [{ serverId: "home", label: "  " }],
      ),
    ]).toEqual([
      ["one", "PrintStream (home)"],
      ["two", "PrintStream (wsl)"],
    ]);
  });
});
