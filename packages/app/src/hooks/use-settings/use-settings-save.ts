import { useCallback, useRef, useState } from "react";
import { useSettingsEditingBlocked } from "./editing-blocker";
import { useAppSettings, type AppSettingsUpdate } from "./index";

/** Own a settings surface's pending/error state while storage retains durable write ordering. */
export function useSettingsSave<Key extends string>() {
  const appSettings = useAppSettings();
  const editingBlocked = useSettingsEditingBlocked();
  const { updateSettings } = appSettings;
  const saving = useRef(false);
  const [pending, setPending] = useState<Key | null>(null);
  const [failed, setFailed] = useState<Key | null>(null);

  /** Catch rejected writes at the UI boundary; retry by submitting the unchanged control again. */
  const save = useCallback(
    async (key: Key, updates: AppSettingsUpdate) => {
      if (saving.current) return;
      saving.current = true;
      setPending(key);
      setFailed(null);

      try {
        await updateSettings(updates);
      } catch {
        setFailed(key);
      } finally {
        saving.current = false;
        setPending(null);
      }
    },
    [updateSettings],
  );

  return {
    ...appSettings,
    isLoading: appSettings.isLoading || editingBlocked,
    isLocalLoading: appSettings.isLoading,
    pending,
    failed,
    save,
  };
}
