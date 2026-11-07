import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";

/**
 * The status the project header's leading glyph shows.
 *
 * Without activity chips the glyph keeps upstream's behaviour: it carries the aggregate only
 * while the project is collapsed. With chips on, the glyph always shows the aggregate except
 * "running": the chip already shows the working ring, and a second ring on the same row would
 * repeat it.
 *
 * @param bucket the project's aggregate status, or null when it is unknown.
 * @param chipsEnabled whether the Project activity chips preference is on.
 * @param collapsed whether the project's workspace rows are hidden.
 */
export function resolveProjectLeadingStatus({
  bucket,
  chipsEnabled,
  collapsed,
}: {
  bucket: SidebarStateBucket | null;
  chipsEnabled: boolean;
  collapsed: boolean;
}): SidebarStateBucket | null {
  if (!chipsEnabled) {
    return collapsed ? bucket : null;
  }
  if (bucket === "running") {
    return null;
  }
  return bucket;
}
