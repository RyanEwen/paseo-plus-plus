import { describe, expect, it } from "vitest";
import { sameWorkspaceTreeAgents, type WorkspaceTreeAgent } from "./workspace-tree";

function treeAgent(
  id: string,
  workspaceId: string,
  parentAgentId: string | null = null,
): WorkspaceTreeAgent {
  return { id, workspaceId, parentAgentId };
}

function agents(...entries: WorkspaceTreeAgent[]): ReadonlyMap<string, WorkspaceTreeAgent> {
  return new Map(entries.map((agent) => [agent.id, agent]));
}

describe("workspace tree agent comparison", () => {
  const parent = treeAgent("parent", "w-parent");
  const child = treeAgent("child", "w-child", "parent");

  it("treats fresh collections with the same relationships as equal", () => {
    expect(sameWorkspaceTreeAgents(agents(parent, child), agents(parent, { ...child }))).toBe(true);
  });

  it("detects a changed parent, workspace, archive state or membership", () => {
    const before = agents(parent, child);
    expect(sameWorkspaceTreeAgents(before, agents(parent, { ...child, parentAgentId: null }))).toBe(
      false,
    );
    expect(
      sameWorkspaceTreeAgents(before, agents(parent, { ...child, workspaceId: "other" })),
    ).toBe(false);
    expect(
      sameWorkspaceTreeAgents(before, agents(parent, { ...child, archivedAt: new Date(0) })),
    ).toBe(false);
    expect(sameWorkspaceTreeAgents(before, agents(parent))).toBe(false);
    expect(sameWorkspaceTreeAgents(before, agents(parent, treeAgent("other", "w-child")))).toBe(
      false,
    );
  });
});
