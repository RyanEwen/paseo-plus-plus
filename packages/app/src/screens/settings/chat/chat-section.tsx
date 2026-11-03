import { selectChatPreferencesSupport } from "@/appearance/chat-preferences-support";
import { useSettingsSyncState } from "@/settings-sync/bootstrap";
import { useSessionStore } from "@/stores/session-store";
import { useSettingsSave } from "@/hooks/use-settings/use-settings-save";
import { useCallback, useMemo } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  SettingsCard,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@/components/settings";
import { isNative } from "@/constants/platform";
import { type ChatDisplay } from "@/hooks/use-settings";

const CHAT_DISPLAYS: readonly ChatDisplay[] = ["full", "collapseToolCalls", "collapseTurns"];

export function ChatSection() {
  const { t } = useTranslation();
  const { selectedHost } = useSettingsSyncState();
  const supported = useSessionStore((state) => selectChatPreferencesSupport(state, selectedHost));
  const { settings, save, pending, failed, isLoading, error } = useSettingsSave<
    "chatDisplay" | "autoExpandReasoning" | "chatOutlineEnabled"
  >();

  const chatDisplayOptions = useMemo(
    () =>
      CHAT_DISPLAYS.map((value) => ({
        value,
        label: t(`settings.general.chatDisplay.options.${value}`),
      })),
    [t],
  );

  const changeChatDisplay = useCallback(
    (chatDisplay: ChatDisplay) => void save("chatDisplay", { chatDisplay }),
    [save],
  );
  const changeAutoExpandReasoning = useCallback(
    (autoExpandReasoning: boolean) => void save("autoExpandReasoning", { autoExpandReasoning }),
    [save],
  );
  const changeChatOutline = useCallback(
    (chatOutlineEnabled: boolean) => void save("chatOutlineEnabled", { chatOutlineEnabled }),
    [save],
  );

  return (
    <View>
      <SettingsSection title={t("settings.appearance.detailLevel.title")}>
        <SettingsCard>
          <SettingsSwitch
            label={t("settings.general.autoExpandReasoning.label")}
            hint={t("settings.general.autoExpandReasoning.description")}
            value={settings.autoExpandReasoning}
            onValueChange={changeAutoExpandReasoning}
          />
          <SettingsSelect
            label={t("settings.general.chatDisplay.label")}
            hint={t(
              supported
                ? "settings.general.chatDisplay.description"
                : "settings.general.chatDisplay.updateHost",
            )}
            disabled={!supported || isLoading || pending !== null || error !== null}
            error={failed === "chatDisplay" ? t("paseoPlusPlus.saveFailed") : undefined}
            value={settings.chatDisplay}
            options={chatDisplayOptions}
            onValueChange={changeChatDisplay}
          />
          {isNative ? null : (
            <SettingsSwitch
              label={t("settings.appearance.chatOutline.title")}
              hint={t("settings.appearance.chatOutline.description")}
              value={settings.chatOutlineEnabled}
              onValueChange={changeChatOutline}
            />
          )}
        </SettingsCard>
      </SettingsSection>
    </View>
  );
}
