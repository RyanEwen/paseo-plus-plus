import { useCallback, useMemo, useState } from "react";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import { useSidebarRecencyClock } from "./workspace-recency-clock";
import { limitSidebarWorkspaces } from "./workspace-limit";
import type { ActiveWorkspaceSelection } from "@/stores/last-workspace-selection";

/**
 * Limit a sidebar group by the active mode's count and age windows, with a per-mode Show more.
 *
 * @param keep optional stable predicate for rows that stay visible outside both windows (the
 *   open workspace); omit it when nothing must stay.
 */
export function useLimitedSidebarGroup<T>(
  items: readonly T[],
  getStatusEnteredAt: (item: T) => Date | null,
  keep?: (item: T) => boolean,
) {
  const mode = useSidebarViewStore((state) => state.groupMode);
  const [expandedModes, setExpandedModes] = useState({ project: false, status: false });
  const expanded = expandedModes[mode];
  const initialCount = useSidebarViewStore((state) => state.initialWorkspaceCount);
  const days = useSidebarViewStore((state) => state.workspaceUpdatedWithinDays);
  const now = useSidebarRecencyClock();
  const { visibleItems, canToggle } = useMemo(
    () =>
      limitSidebarWorkspaces({
        items,
        initialCount,
        expanded,
        updatedWithin: days === null ? undefined : { days, now, getStatusEnteredAt },
        keep,
      }),
    [expanded, items, initialCount, days, now, getStatusEnteredAt, keep],
  );
  const toggleExpanded = useCallback(
    () => setExpandedModes((current) => ({ ...current, [mode]: !current[mode] })),
    [mode],
  );

  return { visibleItems, canToggle, expanded, toggleExpanded };
}

/**
 * A stable predicate that keeps the open workspace visible past a group's limits, or undefined
 * when no workspace is open.
 */
export function useOpenWorkspaceKeep(
  selection: ActiveWorkspaceSelection | null,
): ((item: { serverId: string; workspaceId: string }) => boolean) | undefined {
  const serverId = selection?.serverId ?? null;
  const workspaceId = selection?.workspaceId ?? null;
  return useMemo(() => {
    if (serverId === null || workspaceId === null) return undefined;
    return (item) => item.serverId === serverId && item.workspaceId === workspaceId;
  }, [serverId, workspaceId]);
}
