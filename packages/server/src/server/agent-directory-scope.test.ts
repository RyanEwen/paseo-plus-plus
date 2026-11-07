import { describe, expect, it } from "vitest";
import { scopeAgentsToWorkspace } from "./agent-directory-scope.js";

const agents = [
  { id: "a", workspaceId: "ws-a" },
  { id: "b", workspaceId: "ws-b" },
  { id: "unplaced", workspaceId: null },
];

describe("scopeAgentsToWorkspace", () => {
  it("returns every agent for an unscoped read", () => {
    expect(scopeAgentsToWorkspace(agents, undefined)).toBe(agents);
  });

  it("keeps only agents owned by the requested workspace", () => {
    expect(scopeAgentsToWorkspace(agents, "ws-a").map((agent) => agent.id)).toEqual(["a"]);
  });

  it("returns nothing when no agent belongs to the workspace", () => {
    expect(scopeAgentsToWorkspace(agents, "ws-missing")).toEqual([]);
  });
});
