import { useMutation } from "@tanstack/react-query";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { SettingsCard, SettingsRow, SettingsSection, SettingsSwitch } from "@/components/settings";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";
import { useHostFeature, useHostPermission } from "@/runtime/host-features";
import { DesktopNotificationsSection } from "@/desktop/components/desktop-notifications-section";
import { resolveAttentionControlState } from "./notifications-attention-state";

/** This control belongs to the selected settings host, not the synced app/device preference document. */
export function NotificationsSection({ serverId }: { serverId: string | null }) {
  const { t } = useTranslation();
  const hosts = useHosts();
  const host = hosts.find((candidate) => candidate.serverId === serverId);
  return (
    <View>
      {serverId ? (
        <HostAttentionControl key={serverId} serverId={serverId} label={host?.label ?? serverId} />
      ) : (
        <SettingsSection title={t("settings.notifications.title")}>
          <SettingsCard>
            <SettingsRow
              label={t("settings.notifications.agentAware")}
              hint={t("settings.notifications.chooseHost")}
            />
          </SettingsCard>
        </SettingsSection>
      )}
      <DesktopNotificationsSection />
    </View>
  );
}

/** Keying by host retires pending/error UI ownership; late A acknowledgements cannot flip B. */
function HostAttentionControl({ serverId, label }: { serverId: string; label: string }) {
  const { t } = useTranslation();
  const connected = useHostRuntimeIsConnected(serverId);
  const supported = useHostFeature(serverId, "agentAudienceAttentionSettings");
  const writable = useHostPermission(serverId, "daemon.manage");
  const { config, isLoading, error, retry, patchConfig } = useDaemonConfig(serverId);
  const mutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      const saved = await patchConfig({ notifications: { agentAwareAttention: enabled } });
      if (saved.notifications?.agentAwareAttention !== enabled) {
        throw new Error(t("settings.notifications.notSaved"));
      }
    },
  });
  const { mutate } = mutation;
  const changeAttention = useCallback((enabled: boolean) => mutate(enabled), [mutate]);
  const control = resolveAttentionControlState({
    host: label,
    connected,
    supported,
    writable,
    config,
    isLoading,
    loadFailed: error !== null,
    isPending: mutation.isPending,
  });
  const { key: hintKey, ...hintParams } = control.hint;
  return (
    <SettingsSection title={t("settings.notifications.hostTitle", { host: label })}>
      {control.visible ? (
        <SettingsCard>
          <SettingsSwitch
            label={t("settings.notifications.agentAware")}
            hint={t(hintKey, hintParams)}
            value={control.value}
            disabled={control.disabled}
            onValueChange={changeAttention}
            error={mutation.error?.message}
            testID="agent-aware-attention-setting"
          />
        </SettingsCard>
      ) : null}
      {error ? (
        <Alert variant="error" description={t("settings.notifications.loadFailed")}>
          <Button variant="outline" size="sm" onPress={retry}>
            {t("common.actions.retry")}
          </Button>
        </Alert>
      ) : null}
    </SettingsSection>
  );
}
