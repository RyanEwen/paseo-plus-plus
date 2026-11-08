import { useAppSettings } from "@/hooks/use-settings";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { resolveProjectLeadingStatus } from "./project-leading-status";

/** How a project header presents its aggregate status under the activity chips preference. */
export interface ProjectHeaderActivity {
  /** The status the leading glyph shows. */
  leadingStatus: SidebarStateBucket | null;
  /** Whether the glyph's status badge leaves its announcement to the chip. */
  leadingStatusHiddenFromAccessibility: boolean;
  /** The status the chip shows, or null when the chip is off or the status is unknown. */
  chipBucket: SidebarStateBucket | null;
}

/**
 * Read the Project activity chips preference once for a project header and decide what its
 * leading glyph and chip show. Keeping these decisions here leaves the upstream header row
 * without the fork's branches.
 *
 * @param bucket the project's aggregate status, or null when it is unknown.
 * @param collapsed whether the project's workspace rows are hidden.
 */
export function useProjectHeaderActivity({
  bucket,
  collapsed,
}: {
  bucket: SidebarStateBucket | null;
  collapsed: boolean;
}): ProjectHeaderActivity {
  const chipsEnabled = useAppSettings().settings.paseoPlusPlus.sidebarActivityChips;
  return {
    leadingStatus: resolveProjectLeadingStatus({ bucket, chipsEnabled, collapsed }),
    leadingStatusHiddenFromAccessibility: chipsEnabled,
    chipBucket: chipsEnabled ? bucket : null,
  };
}
