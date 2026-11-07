import { selectChatPreferencesSupport } from "@/appearance/chat-preferences-support";
import { useSettingsSyncState } from "@/settings-sync/bootstrap";
import { useSessionStore } from "@/stores/session-store";
import { useSettingsSave } from "@/hooks/use-settings/use-settings-save";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { SettingsCard, SettingsSection, SettingsSelect } from "@/components/settings";
import { type SendShortcut, type SendBehavior } from "@/hooks/use-settings";
import { useKeyboardShortcutsAvailable } from "@/keyboard/availability";
import { getShortcutOs } from "@/utils/shortcut-platform";

const SEND_BEHAVIORS: readonly SendBehavior[] = ["interrupt", "steer", "queue"];

export function SendingSection() {
  const { t } = useTranslation();
  const { settings, save, pending, failed, isLoading, isEditingBlocked, error } = useSettingsSave<
    "sendBehavior" | "sendShortcut"
  >();
  const { selectedHost } = useSettingsSyncState();
  const supported = useSessionStore((state) => selectChatPreferencesSupport(state, selectedHost));
  const shortcutsAvailable = useKeyboardShortcutsAvailable();
  const modifier = getShortcutOs() === "mac" ? "⌘" : "Ctrl";
  const options = useMemo(
    () =>
      SEND_BEHAVIORS.map((value) => ({
        value,
        label: t(`settings.general.defaultSend.options.${value}`),
      })),
    [t],
  );
  const change = useCallback(
    (sendBehavior: SendBehavior) => void save("sendBehavior", { sendBehavior }),
    [save],
  );
  const shortcutOptions = useMemo(
    () =>
      (["enter", "mod-enter"] as const).map((value) => ({
        value,
        label: t(`settings.general.sendShortcut.options.${value}`, { modifier }),
      })),
    [t, modifier],
  );
  const changeSendShortcut = useCallback(
    (sendShortcut: SendShortcut) => void save("sendShortcut", { sendShortcut }),
    [save],
  );
  return (
    <SettingsSection title={t("settings.general.sending")}>
      <SettingsCard>
        {shortcutsAvailable ? (
          <SettingsSelect
            label={t("settings.general.sendShortcut.label")}
            hint={supported ? undefined : t("settings.general.chatDisplay.updateHost")}
            disabled={
              !supported || isLoading || isEditingBlocked || pending !== null || error !== null
            }
            error={failed === "sendShortcut" ? t("paseoPlusPlus.saveFailed") : undefined}
            value={settings.sendShortcut}
            options={shortcutOptions}
            onValueChange={changeSendShortcut}
          />
        ) : null}
        <SettingsSelect
          label={t("settings.general.defaultSend.label")}
          disabled={isLoading || isEditingBlocked || pending !== null || error !== null}
          error={failed === "sendBehavior" ? t("paseoPlusPlus.saveFailed") : undefined}
          hint={t(
            shortcutsAvailable && settings.sendShortcut === "mod-enter"
              ? `settings.general.defaultSend.commandEnterDescriptions.${settings.sendBehavior}`
              : `settings.general.defaultSend.descriptions.${settings.sendBehavior}`,
            { modifier },
          )}
          value={settings.sendBehavior}
          options={options}
          onValueChange={change}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
