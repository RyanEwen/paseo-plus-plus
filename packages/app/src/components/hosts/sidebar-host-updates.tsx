import { useCallback, useMemo, useReducer, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useShallow } from "zustand/react/shallow";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { isVersionMismatch } from "@/desktop/updates/desktop-updates";
import { useAppSettings } from "@/hooks/use-settings";
import { useDaemonUpdate } from "@/hooks/use-daemon-update";
import type { DaemonUpdateOutcome, DaemonUpdateState } from "@/hosts/daemon-update";
import { useSessionStore } from "@/stores/session-store";
import type { HostProfile } from "@/types/host-connection";
import { resolveAppVersion } from "@/utils/app-version";
import { HostUpdateAction } from "./host-update-action";
import { resolveHostUpdateSupport } from "./host-update-eligibility";
import { createHostServerInfoSelector } from "./host-server-info-selector";
import {
  CLOSED_HOST_UPDATE,
  isHostUpdateSheetVisible,
  reduceHostUpdatePresentation,
} from "./sidebar-host-update-presentation";

interface SidebarHostUpdatesInput {
  hosts: HostProfile[];
  /** The host menu is open; rows check availability only while it is. */
  isOpen: boolean;
  /** Close the host menu before an update's confirmation and progress take over. */
  onBeforeUpdate: () => void;
}

interface SidebarHostUpdates {
  /** Row action for the host picker's `renderHostAction`. */
  renderHostAction: (serverId: string) => ReactNode;
  /** The update sheet, rendered outside the picker so closing the menu keeps progress. */
  sheet: ReactNode;
}

/**
 * Offer Paseo++ host updates from the sidebar host menu. Owns the Paseo++ setting gate, the
 * hosts' server info, and the one update attempt the sidebar can run at a time.
 */
export function useSidebarHostUpdates({
  hosts,
  isOpen,
  onBeforeUpdate,
}: SidebarHostUpdatesInput): SidebarHostUpdates {
  const { settings, isLoading: settingsLoading, error: settingsError } = useAppSettings();
  const showHostUpdates =
    !settingsLoading && settingsError === null && settings.paseoPlusPlus.sidebarHostUpdates;

  // The collection owns the hot session subscription; action rows receive stable server-info facts.
  const selectHostInfo = useMemo(
    () => createHostServerInfoSelector(hosts.map((host) => host.serverId)),
    [hosts],
  );
  const hostInfo = useSessionStore(useShallow(selectHostInfo));
  const hostsById = useMemo(() => new Map(hosts.map((host) => [host.serverId, host])), [hosts]);

  const { updateState, handleUpdate, reset } = useDaemonUpdate();
  const [presentation, dispatch] = useReducer(reduceHostUpdatePresentation, CLOSED_HOST_UPDATE);

  const beginUpdate = useCallback(
    (host: HostProfile) => {
      if (presentation.busy) return;
      onBeforeUpdate();
      dispatch({ type: "start", host });
      // A new attempt never shows the previous attempt's outcome behind its confirmation.
      reset();

      async function run() {
        let outcome: DaemonUpdateOutcome = "settled";
        try {
          outcome = await handleUpdate(host);
        } finally {
          dispatch({ type: "finished", outcome });
        }
      }
      void run();
    },
    [handleUpdate, onBeforeUpdate, presentation.busy, reset],
  );

  const renderHostAction = useCallback(
    (serverId: string) => {
      // Unmount availability observers without interrupting an already-started update sheet.
      if (!showHostUpdates) return null;
      const host = hostsById.get(serverId);
      if (!host) return null;
      const info = hostInfo[serverId];
      const updateSupport = resolveHostUpdateSupport(info, {
        versionDiffersFromApp: isVersionMismatch(resolveAppVersion(), info?.version),
      });
      return (
        <HostUpdateAction
          host={host}
          updateSupport={updateSupport}
          daemonVersion={info?.version ?? null}
          enabled={isOpen}
          busy={presentation.busy}
          onUpdate={beginUpdate}
        />
      );
    },
    [beginUpdate, hostInfo, hostsById, isOpen, presentation.busy, showHostUpdates],
  );

  const updating = updateState.status === "updating";
  const dismiss = useCallback(() => {
    // Dismiss the presentation while the owner continues worker verification.
    dispatch(updating ? { type: "dismiss" } : { type: "close" });
  }, [updating]);

  const sheet = presentation.host ? (
    <HostUpdateSheet
      host={presentation.host}
      state={updateState}
      visible={isHostUpdateSheetVisible(presentation, updateState.status)}
      onClose={dismiss}
    />
  ) : null;

  return { renderHostAction, sheet };
}

interface HostUpdateSheetProps {
  host: HostProfile;
  state: DaemonUpdateState;
  visible: boolean;
  onClose: () => void;
}

/** Progress and outcome of the sidebar's update attempt for `host`. */
function HostUpdateSheet({ host, state, visible, onClose }: HostUpdateSheetProps) {
  const { t } = useTranslation();
  const header = useMemo(
    () => ({ title: t("settings.host.daemon.update.confirmTitle", { name: host.label }) }),
    [host.label, t],
  );
  return (
    <AdaptiveModalSheet
      visible={visible}
      header={header}
      onClose={onClose}
      desktopMaxWidth={480}
      testID="sidebar-host-update-sheet"
    >
      <View style={styles.content}>
        {state.status === "updating" ? <Text style={styles.text}>{state.phase}</Text> : null}
        {state.status === "complete" ? (
          <Alert
            variant="success"
            size="sm"
            title={t("desktop.daemon.lifecycle.workerUpdated", { version: state.workerVersion })}
            description={t("desktop.daemon.lifecycle.supervisorRefresh")}
          />
        ) : null}
        {state.status === "failed" ? (
          <Alert variant="error" size="sm" title={state.title} description={state.message} />
        ) : null}
        <Button variant="outline" onPress={onClose}>
          {t("common.actions.close")}
        </Button>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: { padding: theme.spacing[4], gap: theme.spacing[4] },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
}));
