import { describe, expect, it } from "vitest";
import {
  type CollapsedProjectsState,
  mergePersistedCollapsedProjects,
  serializeCollapsedProjects,
  setProjectCollapsed,
  togglePinnedCollapsed,
  toggleProjectCollapsed,
  toggleWorkspaceGroupCollapsed,
} from "@/stores/sidebar-collapsed-sections-store/state";

function emptyState(): CollapsedProjectsState {
  return {
    collapsedProjectKeys: new Set(),
    collapsedWorkspaceGroupKeys: new Set(),
    collapsedPinned: false,
  };
}

describe("sidebar collapsed projects transitions", () => {
  it("tracks collapsed project keys as a Set", () => {
    let state = emptyState();

    state = setProjectCollapsed(state, "project-a", true);
    state = toggleProjectCollapsed(state, "project-b");
    state = toggleProjectCollapsed(state, "project-a");
    state = toggleWorkspaceGroupCollapsed(state, "running");

    expect(Array.from(state.collapsedProjectKeys)).toEqual(["project-b"]);
    expect(Array.from(state.collapsedWorkspaceGroupKeys)).toEqual(["running"]);
  });

  it("serializes collapsed project keys for preference storage", () => {
    const state: CollapsedProjectsState = {
      collapsedProjectKeys: new Set(["project-a", "project-b"]),
      collapsedWorkspaceGroupKeys: new Set(["running"]),
      collapsedPinned: true,
    };

    expect(serializeCollapsedProjects(state)).toEqual({
      collapsedProjectKeys: ["project-a", "project-b"],
      collapsedWorkspaceGroupKeys: ["running"],
      collapsedPinned: true,
    });
  });

  it("toggles and restores the pinned section collapse flag", () => {
    const toggled = togglePinnedCollapsed(emptyState());
    expect(toggled.collapsedPinned).toBe(true);

    const restored = mergePersistedCollapsedProjects({ collapsedPinned: true }, emptyState());
    expect(restored.collapsedPinned).toBe(true);
  });

  it("rejects the complete value when a persisted project key is invalid", () => {
    const restored = mergePersistedCollapsedProjects(
      { collapsedProjectKeys: ["project-a", "project-b", 42] },
      emptyState(),
    );

    expect(Array.from(restored.collapsedProjectKeys)).toEqual([]);
    expect(Array.from(restored.collapsedWorkspaceGroupKeys)).toEqual([]);
  });

  it("keeps the existing state object when persisted preferences do not change collapsed keys", () => {
    const currentState = emptyState();

    expect(mergePersistedCollapsedProjects(undefined, currentState)).toBe(currentState);
    expect(mergePersistedCollapsedProjects({}, currentState)).toBe(currentState);
    expect(mergePersistedCollapsedProjects({ collapsedProjectKeys: [] }, currentState)).toBe(
      currentState,
    );
  });
});

describe("one project at a time", () => {
  const projectKeys = ["host-a:project-a", "host-b:project-a", "offline:project-b"];
  const options = { mode: "project" as const, oneProjectAtATime: true, projectKeys };

  it("expanding B collapses A across hosts while preserving unrelated collapse owners", () => {
    const initial = {
      ...emptyState(),
      collapsedProjectKeys: new Set([projectKeys[1], "unavailable:key"]),
      collapsedWorkspaceGroupKeys: new Set(["running"]),
      collapsedPinned: false,
    };
    const next = toggleProjectCollapsed(initial, projectKeys[1], options);
    expect([...next.collapsedProjectKeys].sort()).toEqual(
      [projectKeys[0], projectKeys[2], "unavailable:key"].sort(),
    );
    expect(next.collapsedWorkspaceGroupKeys).toBe(initial.collapsedWorkspaceGroupKeys);
    expect(next.collapsedPinned).toBe(false);
    expect(initial.collapsedProjectKeys.has(projectKeys[0])).toBe(false);
  });

  it("re-collapsing a project opens no other project", () => {
    const expanded = setProjectCollapsed(emptyState(), projectKeys[1], false, options);
    const collapsed = toggleProjectCollapsed(expanded, projectKeys[1], options);
    expect([...collapsed.collapsedProjectKeys].sort()).toEqual([...projectKeys].sort());
  });

  it.each([
    { mode: "project" as const, oneProjectAtATime: false },
    { mode: "status" as const, oneProjectAtATime: true },
  ])("keeps multiple projects open for %o", (policy) => {
    const initial = { ...emptyState(), collapsedProjectKeys: new Set([projectKeys[1]]) };
    const next = toggleProjectCollapsed(initial, projectKeys[1], { ...policy, projectKeys });
    expect(next.collapsedProjectKeys.size).toBe(0);
  });

});
