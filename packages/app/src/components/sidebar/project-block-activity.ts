import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import type { SidebarProjectActivity } from "./sidebar-project-activity";

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

const NO_PROJECT_ACTIVITY: SidebarProjectActivity = { bucket: null, workingCount: 0 };

/** A project's summarized activity; a project missing from the summary shows no chip. */
export function getProjectActivity(
  projectActivity: ReadonlyMap<string, SidebarProjectActivity>,
  projectViewKey: string,
): SidebarProjectActivity {
  return projectActivity.get(projectViewKey) ?? NO_PROJECT_ACTIVITY;
}
