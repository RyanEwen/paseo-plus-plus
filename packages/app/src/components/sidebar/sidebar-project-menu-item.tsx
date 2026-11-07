import { ProjectActivityChip } from "./project-activity-chip";
import type { SidebarProjectActivity } from "./sidebar-project-activity";
import { useCallback, useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { MenuItem, type MenuItemSecondary } from "@/components/ui/menu";
import { ProjectIconView } from "@/components/project-icon-view";
import { projectIconPlaceholderLabelFromDisplayName } from "@/utils/project-display-name";

/**
 * A project row in the sidebar chooser: the name selects only this project, and a separate
 * checkbox adds or removes it from a multi-project selection.
 */
export function SidebarProjectMenuItem({
  viewKey,
  label,
  iconDataUri,
  selected,
  activity,
  onSelect,
  onToggle,
  testID,
}: {
  viewKey: string;
  label: string;
  iconDataUri: string | null;
  selected: boolean;
  activity?: SidebarProjectActivity;
  onSelect: (viewKey: string) => void;
  /** Adds or removes this project from the selection without closing the menu. */
  onToggle: (viewKey: string) => void;
  testID: string;
}): ReactElement {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => onSelect(viewKey), [viewKey, onSelect]);
  const handleToggle = useCallback(() => onToggle(viewKey), [onToggle, viewKey]);
  const secondary = useMemo<MenuItemSecondary>(
    () => ({
      kind: "toggle",
      checked: selected,
      accessibilityLabel: t("sidebar.projectSelector.includeProject", { project: label }),
      onSelect: handleToggle,
      testID: `${testID}-checkbox`,
    }),
    [selected, t, label, handleToggle, testID],
  );
  const trailing = useMemo(
    () =>
      activity ? (
        <ProjectActivityChip
          bucket={activity.bucket}
          workingWorkspaceCount={activity.workingCount}
          projectViewKey={viewKey}
          testID={`${testID}-activity`}
          spinnerTestID={`${testID}-working-spinner`}
        />
      ) : undefined,
    [activity, viewKey, testID],
  );
  const leading = useMemo(
    () => (
      <ProjectIconView
        iconDataUri={iconDataUri}
        initial={projectIconPlaceholderLabelFromDisplayName(label).charAt(0).toUpperCase()}
        projectViewKey={viewKey}
        size={14}
        textStyle={styles.projectIconText}
      />
    ),
    [iconDataUri, label, viewKey],
  );

  return (
    <MenuItem
      secondary={secondary}
      trailing={trailing}
      accessibilityLabel={t("sidebar.projectSelector.selectOnlyProject", { project: label })}
      leading={leading}
      onSelect={handleSelect}
      testID={testID}
    >
      {label}
    </MenuItem>
  );
}

const styles = StyleSheet.create({
  // Match the existing 14pt menu icon slot rather than the sidebar row's larger initial.
  projectIconText: { fontSize: 8 },
});
