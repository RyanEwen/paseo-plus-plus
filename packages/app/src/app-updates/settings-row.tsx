import { useCallback } from "react";
import { View, Text } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { settingsStyles } from "@/styles/settings";
import { isAndroidUpdateBusy, isAndroidUpdateTransferring } from "./store";
import { useAndroidUpdater } from "./use-android-updater";
import { describeAndroidUpdate } from "./status";

/** Fork APK controls follow the existing About update row and Android's install approval flow. */
export function AndroidAppUpdateRow() {
  const { t } = useTranslation();
  const available = useAndroidUpdater((state) => state.available);
  const status = useAndroidUpdater((state) => state.status);
  const update = useAndroidUpdater((state) => state.update);
  const error = useAndroidUpdater((state) => state.error);
  const progress = useAndroidUpdater((state) => state.progress);
  const check = useAndroidUpdater((state) => state.check);
  const install = useAndroidUpdater((state) => state.install);
  const handleCheck = useCallback(() => void check({ intent: "manual" }), [check]);
  const handleInstall = useCallback(() => void install(), [install]);
  if (!available) return null;
  const busy = isAndroidUpdateBusy(status);
  return (
    <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{t("settings.about.updates.label")}</Text>
        <Text style={status === "error" ? settingsStyles.rowError : settingsStyles.rowHint}>
          {describeAndroidUpdate({ status, update, error, progress })}
        </Text>
      </View>
      <View style={styles.actions}>
        <Button variant="outline" disabled={busy} onPress={handleCheck}>
          {status === "checking"
            ? t("settings.about.updates.checking")
            : t("settings.about.updates.check")}
        </Button>
        {update ? (
          <Button
            variant="default"
            disabled={busy}
            loading={isAndroidUpdateTransferring(status)}
            onPress={handleInstall}
          >
            {t("androidUpdates.install")}
          </Button>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // Same arrangement as the desktop update row in About.
  actions: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
}));
