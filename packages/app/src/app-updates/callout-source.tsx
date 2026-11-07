import { useEffect } from "react";
import { AppState } from "react-native";
import { useTranslation } from "react-i18next";
import { useAppSettings } from "@/hooks/use-settings";
import { useSidebarCallouts } from "@/contexts/sidebar-callout-context";
import { isAndroidUpdateTransferring } from "./store";
import { useAndroidUpdater } from "./use-android-updater";
import { describeAndroidUpdate } from "./status";

const checkIntervalMs = 30 * 60 * 1000;

/** Check at startup and on resume, and offer explicit installation without interrupting work. */
export function AndroidUpdateCalloutSource() {
  const { t } = useTranslation();
  const callouts = useSidebarCallouts();
  const { settings, isLoading, error: settingsError } = useAppSettings();
  const automaticChecksAllowed =
    !isLoading && settingsError === null && settings.paseoPlusPlus.androidAutomaticUpdateChecks;
  const available = useAndroidUpdater((state) => state.available);
  const status = useAndroidUpdater((state) => state.status);
  const update = useAndroidUpdater((state) => state.update);
  const error = useAndroidUpdater((state) => state.error);
  const progress = useAndroidUpdater((state) => state.progress);
  const check = useAndroidUpdater((state) => state.check);
  const install = useAndroidUpdater((state) => state.install);
  useEffect(() => {
    // Wait for persisted opt-outs before scheduling any automatic network request.
    if (!available || !automaticChecksAllowed) return;
    void check({ intent: "automatic" });
    const timer = setInterval(() => {
      if (AppState.currentState === "active") void check({ intent: "automatic" });
    }, checkIntervalMs);
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") void check({ intent: "automatic" });
    });
    return () => {
      clearInterval(timer);
      listener.remove();
    };
  }, [available, check, automaticChecksAllowed]);

  useEffect(() => {
    if (!available || (!update && !error) || status === "checking") return;
    const busy = isAndroidUpdateTransferring(status);
    return callouts.show({
      id: "android-app-update",
      dismissalKey: `android-app-update:${update?.version ?? "error"}:${status}`,
      priority: 200,
      title:
        status === "available"
          ? t("desktop.updates.callout.availableTitle")
          : t("androidUpdates.title"),
      description: describeAndroidUpdate({ status, update, error, progress }),
      variant: status === "error" ? "error" : "default",
      actions: [
        {
          label: update ? t("androidUpdates.install") : t("common.actions.retry"),
          onPress: () => {
            if (update) void install();
            else void check({ intent: "manual" });
          },
          variant: "primary",
          disabled: busy,
        },
      ],
      testID: "android-update-callout",
    });
  }, [available, callouts, status, update, error, progress, check, install, t]);
  return null;
}
