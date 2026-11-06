import { useCallback, useMemo, useState } from "react";
import type { ArchivedWorkspaceSummary } from "@getpaseo/protocol/messages";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { ComboboxItem } from "@/components/ui/combobox";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { toErrorMessage } from "@/utils/error-messages";
import type { Theme } from "@/styles/theme";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const mutedSpinnerColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const SNAP_POINTS = ["70%", "92%"];

/** Mount a fresh project-scoped chooser each time the project menu opens it. */
export function RestoreProjectWorkspaceDialog({
  visible,
  target,
  onClose,
  onWorkspacePress,
}: {
  visible: boolean;
  target: { serverId: string; projectId: string } | null;
  onClose: () => void;
  onWorkspacePress?: () => void;
}) {
  if (!visible || !target) {
    return null;
  }
  return (
    <OpenRestoreProjectWorkspaceDialog
      key={`${target.serverId}:${target.projectId}`}
      serverId={target.serverId}
      projectId={target.projectId}
      onClose={onClose}
      onWorkspacePress={onWorkspacePress}
    />
  );
}

/** Choose a record without changing lifecycle; the destination owns recovery confirmation. */
function OpenRestoreProjectWorkspaceDialog({
  serverId,
  projectId,
  onClose,
  onWorkspacePress,
}: {
  serverId: string;
  projectId: string;
  onClose: () => void;
  onWorkspacePress?: () => void;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const serverInfo = useSessionStore((state) => state.sessions[serverId]?.serverInfo ?? null);
  // COMPAT(projectArchivedWorkspaces): added in v0.11.2, remove after 2027-04-20.
  const supported = serverInfo?.features?.projectArchivedWorkspaces === true;
  const includeBackground = useSidebarViewStore((state) => state.showBackground);
  const archived = useFetchQuery({
    queryKey: ["projectArchivedWorkspaces", serverId, projectId, includeBackground],
    dataShape: "list",
    staleTimeMs: 0,
    enabled: Boolean(client && connected && supported),
    retry: false,
    queryFn: async () => {
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      return client.listArchivedProjectWorkspaces(projectId, includeBackground);
    },
  });
  const { refetch } = archived;
  const refresh = useCallback(() => {
    void refetch();
  }, [refetch]);
  const selectWorkspace = useCallback(
    (workspaceId: string) => {
      // The destination inspects again so a stale row cannot bypass recovery confirmation.
      navigateToWorkspace({ serverId, workspaceId, recoveryRequested: true });
      onClose();
      onWorkspacePress?.();
    },
    [serverId, onClose, onWorkspacePress],
  );
  const header = useMemo<SheetHeader>(
    () => ({
      title: t("sidebar.project.restore.title"),
      search: {
        onChange: setSearch,
        placeholder: t("sidebar.project.restore.search"),
        autoFocus: true,
      },
    }),
    [t],
  );
  const query = search.trim().toLocaleLowerCase();
  const entries = (archived.data ?? []).filter((entry) =>
    [entry.workspaceName, entry.branch, entry.workspaceDirectory].some((value) =>
      value?.toLocaleLowerCase().includes(query),
    ),
  );

  let content;
  if (!connected || !client) {
    content = <Text style={styles.hint}>{t("workspace.terminal.hostDisconnected")}</Text>;
  } else if (!serverInfo || (supported && (archived.isPending || archived.isFetching))) {
    content = <ThemedLoadingSpinner color="" uniProps={mutedSpinnerColor} />;
  } else if (!supported) {
    content = <Text style={styles.hint}>{t("sidebar.project.restore.updateRequired")}</Text>;
  } else if (archived.isError) {
    content = (
      <>
        <Text style={styles.hint}>{t("sidebar.project.restore.loadFailed")}</Text>
        <Text style={styles.hint}>{toErrorMessage(archived.error)}</Text>
        <Button variant="ghost" onPress={refresh}>
          {t("common.actions.retry")}
        </Button>
      </>
    );
  } else if (entries.length === 0) {
    content = (
      <Text style={styles.hint}>
        {query ? t("sessions.noMatches") : t("sidebar.project.restore.empty")}
      </Text>
    );
  } else {
    content = entries.map((entry) => (
      <ArchivedWorkspaceRow key={entry.workspaceId} entry={entry} onSelect={selectWorkspace} />
    ));
  }

  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={onClose}
      testID="restore-project-workspace-dialog"
      snapPoints={SNAP_POINTS}
      desktopMaxWidth={720}
      desktopHeight="70%"
    >
      <View style={styles.body}>{content}</View>
    </AdaptiveModalSheet>
  );
}

function ArchivedWorkspaceRow({
  entry,
  onSelect,
}: {
  entry: ArchivedWorkspaceSummary;
  onSelect: (workspaceId: string) => void;
}) {
  const handlePress = useCallback(() => onSelect(entry.workspaceId), [entry.workspaceId, onSelect]);
  return (
    <ComboboxItem
      label={entry.workspaceName}
      description={entry.branch || entry.workspaceDirectory}
      testID={`restore-project-workspace-${entry.workspaceId}`}
      onPress={handlePress}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { padding: theme.spacing[3], gap: theme.spacing[2] },
  hint: {
    padding: theme.spacing[3],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
}));
