import { describe, expect, it } from "vitest";
import {
  scopeAgentsToRequestedWorkspace,
  scopeAgentsToWorkspace,
} from "./agent-directory-scope.js";

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

describe("scopeAgentsToRequestedWorkspace", () => {
  it("scopes a history request to its workspace", () => {
    const scoped = scopeAgentsToRequestedWorkspace(agents, {
      type: "fetch_agent_history_request",
      workspaceId: "ws-b",
    });
    expect(scoped.map((agent) => agent.id)).toEqual(["b"]);
  });

  it("leaves an unscoped history request global", () => {
    expect(scopeAgentsToRequestedWorkspace(agents, { type: "fetch_agent_history_request" })).toBe(
      agents,
    );
  });

  it("leaves an active-agent directory read unscoped", () => {
    expect(scopeAgentsToRequestedWorkspace(agents, { type: "fetch_agents_request" })).toBe(agents);
  });
});
