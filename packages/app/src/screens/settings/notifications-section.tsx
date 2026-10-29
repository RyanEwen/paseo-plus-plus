import { isAgentAwareAttentionEnabled } from "@getpaseo/protocol/agent-attention";
import { useMutation } from "@tanstack/react-query";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { SettingsCard, SettingsSection, SettingsSwitch } from "@/components/settings";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { isElectronRuntime } from "@/desktop/host";
import { DesktopNotificationsSection } from "@/desktop/components/desktop-notifications-section";

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
        <Text>{t("settings.notifications.chooseHost")}</Text>
      )}
      {isElectronRuntime() ? <DesktopNotificationsSection /> : null}
    </View>
  );
}

/** Keying by host retires pending/error UI ownership; late A acknowledgements cannot flip B. */
function HostAttentionControl({ serverId, label }: { serverId: string; label: string }) {
  const { t } = useTranslation();
  const connected = useHostRuntimeIsConnected(serverId);
  const supported = useSessionStore(
    (state) =>
      state.sessions[serverId]?.serverInfo?.features?.agentAudienceAttentionSettings === true,
  );
  const writable = useSessionStore(
    (state) =>
      state.sessions[serverId]?.serverInfo?.permissions?.includes("daemon.manage") === true,
  );
  const { config, isLoading, error, retry, patchConfig } = useDaemonConfig(serverId);
  const mutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      if (!supported || !writable || !connected || !config)
        throw new Error(t("settings.notifications.unavailable"));
      const saved = await patchConfig({ notifications: { agentAwareAttention: enabled } });
      if (saved.notifications?.agentAwareAttention !== enabled)
        throw new Error(t("settings.notifications.notSaved"));
    },
  });
  const { mutate } = mutation;
  const changeAttention = useCallback((enabled: boolean) => mutate(enabled), [mutate]);
  const disabled =
    !connected ||
    !supported ||
    !writable ||
    isLoading ||
    error !== null ||
    !config ||
    mutation.isPending;
  let hint = t("settings.notifications.agentAwareHint", { host: label });
  if (!connected) hint = t("workspace.terminal.hostDisconnected");
  else if (!supported) hint = t("settings.notifications.updateHost");
  else if (!writable) hint = t("settings.notifications.readOnly");
  const failure = mutation.error instanceof Error ? mutation.error.message : null;
  return (
    <SettingsSection title={t("settings.notifications.hostTitle", { host: label })}>
      <SettingsCard>
        <SettingsSwitch
          label={t("settings.notifications.agentAware")}
          hint={hint}
          value={config ? isAgentAwareAttentionEnabled(config) : true}
          disabled={disabled}
          onValueChange={changeAttention}
          error={failure ?? undefined}
          testID="agent-aware-attention-setting"
        />
        {mutation.isPending ? (
          <Text accessibilityLiveRegion="polite">{t("settings.notifications.saving")}</Text>
        ) : null}
      </SettingsCard>
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
