import { z } from "zod";

export interface CollapsedProjectsState {
  collapsedProjectKeys: Set<string>;
  collapsedWorkspaceGroupKeys: Set<string>;
  collapsedPinned: boolean;
}

export interface PersistedCollapsedProjects {
  collapsedProjectKeys?: string[];
  collapsedWorkspaceGroupKeys?: string[];
  collapsedStatusGroupKeys?: string[];
  collapsedPinned?: boolean;
}

export const PersistedCollapsedProjectsSchema: z.ZodType<PersistedCollapsedProjects> =
  z.strictObject({
    collapsedProjectKeys: z.array(z.string()).optional(),
    collapsedWorkspaceGroupKeys: z.array(z.string()).optional(),
    // COMPAT(sidebarWorkspaceGroupCollapse): added in v0.4.0, remove after 2027-02-14.
    collapsedStatusGroupKeys: z.array(z.string()).optional(),
    collapsedPinned: z.boolean().optional(),
  });

export function togglePinnedCollapsed(state: CollapsedProjectsState): CollapsedProjectsState {
  return { ...state, collapsedPinned: !state.collapsedPinned };
}

export interface ProjectCollapseOptions {
  /**
   * Project keys to collapse when this project expands. The caller owns the policy (for example
   * one project at a time) and passes an empty list when nothing else should close.
   */
  collapseOthers: readonly string[];
}

export function toggleProjectCollapsed(
  state: CollapsedProjectsState,
  projectKey: string,
  options?: ProjectCollapseOptions,
): CollapsedProjectsState {
  return setProjectCollapsed(
    state,
    projectKey,
    !state.collapsedProjectKeys.has(projectKey),
    options,
  );
}

export function toggleWorkspaceGroupCollapsed(
  state: CollapsedProjectsState,
  workspaceGroupKey: string,
): CollapsedProjectsState {
  const next = new Set(state.collapsedWorkspaceGroupKeys);
  if (next.has(workspaceGroupKey)) {
    next.delete(workspaceGroupKey);
  } else {
    next.add(workspaceGroupKey);
  }
  return { ...state, collapsedWorkspaceGroupKeys: next };
}

export function setProjectCollapsed(
  state: CollapsedProjectsState,
  projectKey: string,
  collapsed: boolean,
  options?: ProjectCollapseOptions,
): CollapsedProjectsState {
  const next = new Set(state.collapsedProjectKeys);
  if (!collapsed && options) {
    for (const key of options.collapseOthers) next.add(key);
  }
  if (collapsed) {
    next.add(projectKey);
  } else {
    next.delete(projectKey);
  }
  return { ...state, collapsedProjectKeys: next };
}

export interface SidebarCollapseTargets {
  projectKeys: readonly string[];
  workspaceGroupKeys: readonly string[];
  includePinned: boolean;
}

/** Copy `current` with every key in `keys` added (collapsed) or removed (expanded). */
function withKeysCollapsed(
  current: ReadonlySet<string>,
  keys: readonly string[],
  collapsed: boolean,
): Set<string> {
  const next = new Set(current);
  for (const key of keys) {
    if (collapsed) {
      next.add(key);
    } else {
      next.delete(key);
    }
  }
  return next;
}

/**
 * Set only the rendered sections, preserving preferences hidden by the current filters.
 *
 * Expand all deliberately takes no ProjectCollapseOptions: it is an explicit override of
 * one-project-at-a-time and expands every targeted project. The next individual toggle, which
 * does receive the options, restores exclusivity.
 */
export function setSectionsCollapsed(
  state: CollapsedProjectsState,
  targets: SidebarCollapseTargets,
  collapsed: boolean,
): CollapsedProjectsState {
  return {
    ...state,
    collapsedProjectKeys: withKeysCollapsed(
      state.collapsedProjectKeys,
      targets.projectKeys,
      collapsed,
    ),
    collapsedWorkspaceGroupKeys: withKeysCollapsed(
      state.collapsedWorkspaceGroupKeys,
      targets.workspaceGroupKeys,
      collapsed,
    ),
    collapsedPinned: targets.includePinned ? collapsed : state.collapsedPinned,
  };
}

export function serializeCollapsedProjects(state: CollapsedProjectsState): {
  collapsedProjectKeys: string[];
  collapsedWorkspaceGroupKeys: string[];
  collapsedPinned: boolean;
} {
  return {
    collapsedProjectKeys: Array.from(state.collapsedProjectKeys),
    collapsedWorkspaceGroupKeys: Array.from(state.collapsedWorkspaceGroupKeys),
    collapsedPinned: state.collapsedPinned,
  };
}

export function mergePersistedCollapsedProjects<S extends CollapsedProjectsState>(
  persistedValue: unknown,
  current: S,
): S {
  const result = PersistedCollapsedProjectsSchema.safeParse(persistedValue);
  if (!result.success) {
    return current;
  }
  const persisted = result.data;
  const restoredProjects = deserializeCollapsedKeys(
    persisted.collapsedProjectKeys ?? Array.from(current.collapsedProjectKeys),
  );
  const restoredWorkspaceGroups = deserializeCollapsedKeys(
    persisted.collapsedWorkspaceGroupKeys ??
      persisted.collapsedStatusGroupKeys ??
      Array.from(current.collapsedWorkspaceGroupKeys),
  );
  const restoredPinned = persisted.collapsedPinned ?? current.collapsedPinned;
  if (
    areSetsEqual(current.collapsedProjectKeys, restoredProjects) &&
    areSetsEqual(current.collapsedWorkspaceGroupKeys, restoredWorkspaceGroups) &&
    current.collapsedPinned === restoredPinned
  ) {
    return current;
  }
  return {
    ...current,
    collapsedProjectKeys: restoredProjects,
    collapsedWorkspaceGroupKeys: restoredWorkspaceGroups,
    collapsedPinned: restoredPinned,
  };
}

function deserializeCollapsedKeys(value: string[]): Set<string> {
  return new Set(value);
}

function areSetsEqual(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const key of left) {
    if (!right.has(key)) {
      return false;
    }
  }
  return true;
}
