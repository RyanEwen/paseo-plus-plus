import { useCallback, useRef, useState } from "react";
import { useSettingsEditingBlocked } from "./editing-blocker";
import { useAppSettings, type AppSettingsUpdate } from "./index";

/**
 * Own a settings surface's pending/error state while storage retains durable write ordering.
 *
 * Returns the app settings plus `isLoading` (this device's settings are not loaded yet),
 * `isEditingBlocked` (a registered blocker, such as a settings host, holds edits), the key being
 * saved, the key whose last save failed, and `save`. A surface can edit a key once neither
 * applies to it.
 */
export function useSettingsSave<Key extends string>() {
  const appSettings = useAppSettings();
  const editingBlocked = useSettingsEditingBlocked();
  const { updateSettings } = appSettings;
  // A ref, not state: two presses in one frame must not both start a write before React
  // re-renders with `pending`. The second press is ignored; its control is disabled meanwhile.
  const inFlight = useRef(false);
  const [pending, setPending] = useState<Key | null>(null);
  const [failed, setFailed] = useState<Key | null>(null);

  /** Catch rejected writes at the UI boundary; retry by submitting the unchanged control again. */
  const save = useCallback(
    async (key: Key, updates: AppSettingsUpdate) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setPending(key);
      setFailed(null);

      try {
        await updateSettings(updates);
      } catch {
        setFailed(key);
      } finally {
        inFlight.current = false;
        setPending(null);
      }
    },
    [updateSettings],
  );

  return {
    ...appSettings,
    isEditingBlocked: editingBlocked,
    pending,
    failed,
    save,
  };
}
