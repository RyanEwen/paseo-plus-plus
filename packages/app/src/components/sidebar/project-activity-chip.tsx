import { useMemo } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { StatusRing } from "@/components/status-ring";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { getStatusBucketLabel } from "@/hooks/sidebar-status-view-model";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";

/** Each aggregate status's badge colour; working uses the running signal, not a warning. */
const VARIANT_BY_BUCKET = {
  needs_input: "warning",
  failed: "error",
  attention: "success",
  running: "info",
  done: "muted",
} as const satisfies Record<SidebarStateBucket, StatusBadgeVariant>;

/** The canonical status label, counting working workspaces once more than one is working. */
function resolveChipLabel(
  bucket: SidebarStateBucket,
  workingWorkspaceCount: number,
  t: TFunction,
): string {
  if (bucket === "running" && workingWorkspaceCount > 1) {
    return t("sidebar.statusBucket.workingCount", { count: workingWorkspaceCount });
  }
  return getStatusBucketLabel(bucket, t);
}

/**
 * Render the canonical aggregate label without competing with the project title.
 *
 * `testID` and `spinnerTestID` default to the sidebar header's IDs; other surfaces that show the
 * same chip (such as a project chooser row) pass their own.
 */
export function ProjectActivityChip({
  bucket,
  workingWorkspaceCount,
  projectViewKey,
  testID = `sidebar-project-status-${projectViewKey}`,
  spinnerTestID = `sidebar-project-working-spinner-${projectViewKey}`,
}: {
  bucket: SidebarStateBucket | null;
  workingWorkspaceCount: number;
  projectViewKey: string;
  testID?: string;
  spinnerTestID?: string;
}) {
  const { t } = useTranslation();
  const leading = useMemo(() => {
    if (bucket !== "running") return undefined;
    return (
      <View testID={spinnerTestID}>
        <StatusRing />
      </View>
    );
  }, [bucket, spinnerTestID]);
  if (!bucket) return null;
  const variant = VARIANT_BY_BUCKET[bucket];
  const label = resolveChipLabel(bucket, workingWorkspaceCount, t);
  return (
    <View role="status" accessibilityLabel={label} style={styles.projectStatusChip} testID={testID}>
      <StatusBadge label={label} size="xs" variant={variant} leading={leading} />
    </View>
  );
}

const styles = StyleSheet.create({ projectStatusChip: { flexShrink: 0 } });
