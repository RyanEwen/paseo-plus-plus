import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";

/** The activity props a memoized project block renders in its header chip. */
export interface ProjectBlockActivityProps {
  aggregateStatusBucket: SidebarStateBucket | null;
  workingWorkspaceCount: number;
}

/**
 * Whether a project block's activity props are unchanged, for its memo comparator.
 *
 * The aggregate can change while every workspace entry keeps its identity, for example when a
 * host reconnects and its cached workspaces become known again, so entry equality alone cannot
 * stand in for these props.
 */
export function projectBlockActivityEqual(
  previous: ProjectBlockActivityProps,
  next: ProjectBlockActivityProps,
): boolean {
  return (
    previous.aggregateStatusBucket === next.aggregateStatusBucket &&
    previous.workingWorkspaceCount === next.workingWorkspaceCount
  );
}
