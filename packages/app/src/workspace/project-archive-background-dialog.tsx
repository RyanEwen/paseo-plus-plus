import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import {
  buildProjectArchiveConfirmation,
  selectProjectArchiveScope,
  type ProjectArchiveWorkspace,
} from "./project-workspace-archive";

/** A fresh, unchecked opt-in for hidden work. Dismissal and Cancel never authorize mutation. */
export function ProjectArchiveBackgroundDialog({
  projectName,
  hostCount,
  workspaces,
  onChoose,
}: {
  projectName: string;
  hostCount: number;
  workspaces: ProjectArchiveWorkspace[];
  onChoose: (includeBackground: boolean | null) => void;
}) {
  const { t } = useTranslation();
  const [includeBackground, setIncludeBackground] = useState(false);
  const selection = selectProjectArchiveScope(workspaces, includeBackground);
  const confirmation = buildProjectArchiveConfirmation({ projectName, hostCount, selection });
  const header = useMemo<SheetHeader>(() => ({ title: confirmation.title }), [confirmation.title]);
  const backgroundCount = workspaces.filter((workspace) => workspace.background).length;
  const backgroundLabel = t("sidebar.project.archive.includeBackground", {
    count: backgroundCount,
  });
  const cancel = useCallback(() => onChoose(null), [onChoose]);
  const confirm = useCallback(() => onChoose(includeBackground), [onChoose, includeBackground]);

  const footer = useMemo(
    () => (
      <View style={styles.actions}>
        <Button
          variant="secondary"
          size="sm"
          style={styles.action}
          onPress={cancel}
          testID="project-archive-cancel"
        >
          {confirmation.cancelLabel}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          style={styles.action}
          onPress={confirm}
          disabled={selection.workspaces.length === 0}
          testID="project-archive-confirm"
        >
          {confirmation.confirmLabel}
        </Button>
      </View>
    ),
    [
      cancel,
      confirm,
      confirmation.cancelLabel,
      confirmation.confirmLabel,
      selection.workspaces.length,
    ],
  );

  return (
    <AdaptiveModalSheet
      visible
      header={header}
      onClose={cancel}
      testID="project-archive-confirmation"
      footer={footer}
    >
      <View style={styles.body}>
        <Text style={styles.message} testID="project-archive-counts">
          {confirmation.message}
        </Text>
        <View style={styles.option}>
          <Text style={styles.optionLabel}>{backgroundLabel}</Text>
          <Switch
            value={includeBackground}
            onValueChange={setIncludeBackground}
            accessibilityLabel={backgroundLabel}
            testID="project-archive-include-background"
          />
        </View>
        <Text style={styles.hint}>{t("sidebar.project.archive.backgroundWarning")}</Text>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.spacing[3] },
  message: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  option: { flexDirection: "row", alignItems: "center", gap: theme.spacing[3] },
  optionLabel: { flex: 1, color: theme.colors.foreground, fontSize: theme.fontSize.base },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  actions: { flexDirection: "row", gap: theme.spacing[2] },
  action: { flex: 1 },
}));
