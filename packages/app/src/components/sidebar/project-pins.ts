import { applyStoredOrdering } from "@/hooks/sidebar-workspaces-view-model";
import type {
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";

/** The entry field project pin policy reads; the host owns the timestamp. */
type ProjectPinSource = Pick<SidebarWorkspaceEntry, "projectPinnedAt">;

/**
 * Whether a row sits in its project's pin partition.
 *
 * Turning the feature off changes presentation only: the host keeps the saved pins, and they
 * apply again when the feature is turned back on.
 *
 * @param entry the hydrated sidebar entry for the row, if one is known.
 * @param enabled the Paseo++ project pinning switch.
 */
export function isProjectPinnedEntry(
  entry: ProjectPinSource | undefined,
  enabled: boolean,
): boolean {
  return enabled && entry?.projectPinnedAt != null;
}

/**
 * Keys of the rows in the pin partition, in the order given.
 *
 * @param workspaces the rows to classify.
 * @param entriesByKey hydrated entries by workspace key.
 * @param enabled the Paseo++ project pinning switch.
 */
export function projectPinnedKeys(
  workspaces: readonly SidebarWorkspacePlacement[],
  entriesByKey: ReadonlyMap<string, ProjectPinSource>,
  enabled: boolean,
): Set<string> {
  const keys = new Set<string>();
  for (const workspace of workspaces) {
    if (isProjectPinnedEntry(entriesByKey.get(workspace.workspaceKey), enabled)) {
      keys.add(workspace.workspaceKey);
    }
  }
  return keys;
}

/**
 * Keep project pins ahead of their sorted siblings without writing the saved custom order.
 *
 * Pins come newest pin first, then any saved manual pin order applies on top, the same rule the
 * global Pinned section uses. Ordinary rows keep the order they arrived in.
 *
 * @param input.workspaces one project's rows, already arranged by the workspace sort.
 * @param input.entriesByKey hydrated entries by workspace key.
 * @param input.enabled the Paseo++ project pinning switch; when off, rows are returned as is.
 * @param input.storedPinOrder the saved manual pin order, shared with global pins.
 */
export function arrangeProjectPinnedWorkspaces<T extends SidebarWorkspacePlacement>(input: {
  workspaces: T[];
  entriesByKey: ReadonlyMap<string, ProjectPinSource>;
  enabled: boolean;
  storedPinOrder: string[];
}): T[] {
  if (!input.enabled) return input.workspaces;

  const pinnedAtByKey = new Map<string, string>();
  for (const workspace of input.workspaces) {
    const pinnedAt = input.entriesByKey.get(workspace.workspaceKey)?.projectPinnedAt;
    if (pinnedAt != null) pinnedAtByKey.set(workspace.workspaceKey, pinnedAt);
  }
  const pins = input.workspaces.filter((workspace) => pinnedAtByKey.has(workspace.workspaceKey));
  pins.sort((a, b) =>
    pinnedAtByKey.get(b.workspaceKey)!.localeCompare(pinnedAtByKey.get(a.workspaceKey)!),
  );
  const ordinary = input.workspaces.filter(
    (workspace) => !pinnedAtByKey.has(workspace.workspaceKey),
  );
  return [
    ...applyStoredOrdering({
      items: pins,
      storedOrder: input.storedPinOrder,
      getKey: (workspace) => workspace.workspaceKey,
    }),
    ...ordinary,
  ];
}
