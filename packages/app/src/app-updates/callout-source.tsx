import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useAppSettings } from "@/hooks/use-settings";
import { useAppActivelyVisible } from "@/hooks/use-app-visible";
import { useSidebarCallouts } from "@/contexts/sidebar-callout-context";
import { getIsAppActivelyVisible } from "@/utils/app-visibility";
import {
  resolveAndroidUpdateCallout,
  shouldRunAutomaticChecks,
  startAutomaticChecks,
} from "./callout-policy";
import { useAndroidUpdater } from "./use-android-updater";

/** Check at startup and on resume, and offer explicit installation without interrupting work. */
export function AndroidUpdateCalloutSource() {
  const { t } = useTranslation();
  const callouts = useSidebarCallouts();
  const { settings, isLoading, error: settingsError } = useAppSettings();
  const available = useAndroidUpdater((state) => state.available);
  const status = useAndroidUpdater((state) => state.status);
  const update = useAndroidUpdater((state) => state.update);
  const error = useAndroidUpdater((state) => state.error);
  const progress = useAndroidUpdater((state) => state.progress);
  const check = useAndroidUpdater((state) => state.check);
  const install = useAndroidUpdater((state) => state.install);
  const visible = useAppActivelyVisible();
  const wasVisible = useRef(visible);
  const automaticChecksAllowed = shouldRunAutomaticChecks({
    available,
    settingsLoading: isLoading,
    settingsError,
    enabled: settings.paseoPlusPlus.androidAutomaticUpdateChecks,
  });

  // Startup check, then the interval, for as long as automatic checks are allowed.
  useEffect(() => {
    if (!automaticChecksAllowed) return;
    return startAutomaticChecks({
      check: () => void check({ intent: "automatic" }),
      isActive: () => getIsAppActivelyVisible(),
    });
  }, [automaticChecksAllowed, check]);

  // Resume: check again whenever the app returns to the foreground.
  useEffect(() => {
    const resumed = visible && !wasVisible.current;
    wasVisible.current = visible;
    if (resumed && automaticChecksAllowed) void check({ intent: "automatic" });
  }, [visible, automaticChecksAllowed, check]);

  useEffect(() => {
    const callout = resolveAndroidUpdateCallout({ available, status, update, error, progress });
    if (!callout) return;
    const onPress =
      callout.action.role === "install"
        ? () => void install()
        : () => void check({ intent: "manual" });
    return callouts.show({
      id: callout.id,
      dismissalKey: callout.dismissalKey,
      priority: callout.priority,
      title: t(callout.titleKey),
      description: callout.description,
      variant: callout.variant,
      actions: [
        {
          label: t(callout.action.labelKey),
          onPress,
          variant: "primary",
          disabled: callout.action.disabled,
        },
      ],
      testID: callout.testID,
    });
  }, [available, callouts, status, update, error, progress, check, install, t]);

  return null;
}
