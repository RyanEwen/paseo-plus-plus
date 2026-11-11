import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { ComboboxItem } from "@/components/ui/combobox";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useFetchQuery } from "@/data/query";
import type { HostBadgeModel } from "@/hosts/appearance";
import { HostBadge } from "@/hosts/host-badge";
import { useHostBadges } from "@/hosts/use-host-badges";
import { selectHostFeature, useHostFeatureAvailabilityMap } from "@/runtime/host-features";
import {
  getHostRuntimeStore,
  isHostRuntimeConnected,
  useHostRuntimeConnectionStatuses,
  useHosts,
} from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import type { Theme } from "@/styles/theme";
import { toErrorMessage } from "@/utils/error-messages";
import {
  listProjectArchivedWorkspaces,
  selectArchivedWorkspaceRows,
  type ArchivedHostListing,
  type ArchivedWorkspaceListingPort,
  type ArchivedWorkspaceRow,
  type ProjectArchiveRestoreHost,
} from "@/workspace/project-archive-restore";
import { requestWorkspaceRecovery } from "@/workspace/workspace-recovery-intent";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const mutedSpinnerColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const SNAP_POINTS = ["70%", "92%"];

/** Live adapter: the host runtime supplies connected clients and the session store capabilities. */
const listingPort: ArchivedWorkspaceListingPort = {
  getConnectedClient: (serverId) => {
    const snapshot = getHostRuntimeStore().getSnapshot(serverId);
    return isHostRuntimeConnected(snapshot) ? (snapshot?.client ?? null) : null;
  },
  supportsListing: (serverId) =>
    selectHostFeature(useSessionStore.getState(), serverId, "projectArchivedWorkspaces"),
};

/** Mount a fresh project-scoped chooser each time the project menu opens it. */
export function RestoreProjectWorkspaceDialog({
  visible,
  hosts,
  onClose,
  onWorkspacePress,
}: {
  visible: boolean;
  /** The hosts whose archives the chooser lists. */
  hosts: readonly ProjectArchiveRestoreHost[];
  onClose: () => void;
  onWorkspacePress?: () => void;
}) {
  if (!visible || hosts.length === 0) {
    return null;
  }
  return (
    <OpenRestoreProjectWorkspaceDialog
      key={hosts.map((host) => `${host.serverId}:${host.projectId}`).join("|")}
      hosts={hosts}
      onClose={onClose}
      onWorkspacePress={onWorkspacePress}
    />
  );
}

/**
 * Load the project's archived records once every connected host's capabilities are known.
 * Connection and capability changes are part of the key so a host that comes online is listed.
 */
function useArchivedWorkspaceListings(hosts: readonly ProjectArchiveRestoreHost[]) {
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const connection = useHostRuntimeConnectionStatuses(serverIds);
  // COMPAT(projectArchivedWorkspaces): added in v0.11.2, remove after 2027-04-20.
  const availability = useHostFeatureAvailabilityMap(serverIds, "projectArchivedWorkspaces");
  const includeBackground = useSidebarViewStore((state) => state.showBackground);
  // A connected host whose server_info has not arrived yet could still support listings.
  const waitingForCapabilities = serverIds.some(
    (serverId) => connection.get(serverId) === "online" && availability.get(serverId) === null,
  );
  const readiness = serverIds
    .map((serverId) => `${connection.get(serverId)}:${availability.get(serverId)}`)
    .join("|");
  const listings = useFetchQuery({
    queryKey: ["projectArchivedWorkspaces", hosts, includeBackground, readiness],
    dataShape: "list",
    staleTimeMs: 0,
    enabled: !waitingForCapabilities,
    retry: false,
    queryFn: () => listProjectArchivedWorkspaces({ hosts, includeBackground, port: listingPort }),
  });
  const loading = waitingForCapabilities || listings.isPending || listings.isFetching;
  return { listings: listings.data ?? [], loading, refetch: listings.refetch };
}

/** Choose a record without changing lifecycle; the destination owns recovery confirmation. */
function OpenRestoreProjectWorkspaceDialog({
  hosts,
  onClose,
  onWorkspacePress,
}: {
  hosts: readonly ProjectArchiveRestoreHost[];
  onClose: () => void;
  onWorkspacePress?: () => void;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const { listings, loading, refetch } = useArchivedWorkspaceListings(hosts);
  const showHosts = hosts.length > 1;
  const badges = useHostBadges({ enabled: showHosts });
  const daemons = useHosts();
  const hostLabel = useCallback(
    (serverId: string) =>
      daemons.find((daemon) => daemon.serverId === serverId)?.label.trim() || serverId,
    [daemons],
  );
  const refresh = useCallback(() => {
    void refetch();
  }, [refetch]);
  const selectWorkspace = useCallback(
    (row: ArchivedWorkspaceRow) => {
      const target = { serverId: row.serverId, workspaceId: row.entry.workspaceId };
      // The destination inspects again so a stale row cannot bypass recovery confirmation.
      requestWorkspaceRecovery(target);
      navigateToWorkspace(target);
      onClose();
      onWorkspacePress?.();
    },
    [onClose, onWorkspacePress],
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
  const rows = selectArchivedWorkspaceRows(listings, search);
  const problems = listings.filter(
    (listing): listing is HostListingProblemKind => listing.kind !== "loaded",
  );

  let content;
  if (loading) {
    content = (
      <View style={styles.state} testID="restore-project-workspace-loading">
        <ThemedLoadingSpinner uniProps={mutedSpinnerColor} />
      </View>
    );
  } else {
    content = (
      <>
        {rows.map((row) => (
          <ArchivedWorkspaceRowItem
            key={`${row.serverId}:${row.entry.workspaceId}`}
            row={row}
            badge={badges.get(row.serverId) ?? null}
            onSelect={selectWorkspace}
          />
        ))}
        {problems.map((listing) => (
          <HostListingProblem
            key={listing.serverId}
            listing={listing}
            hostLabel={hostLabel(listing.serverId)}
            showHost={showHosts}
            onRetry={refresh}
          />
        ))}
        {rows.length === 0 && problems.length === 0 ? (
          <View style={styles.state} testID="restore-project-workspace-empty">
            <Text style={styles.hint}>
              {search.trim() ? t("sessions.noMatches") : t("sidebar.project.restore.empty")}
            </Text>
          </View>
        ) : null}
      </>
    );
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
      <View>{content}</View>
    </AdaptiveModalSheet>
  );
}

/** One archived workspace; when several hosts are listed, the owning host's badge follows it. */
function ArchivedWorkspaceRowItem({
  row,
  badge,
  onSelect,
}: {
  row: ArchivedWorkspaceRow;
  badge: HostBadgeModel | null;
  onSelect: (row: ArchivedWorkspaceRow) => void;
}) {
  const handlePress = useCallback(() => onSelect(row), [row, onSelect]);
  const trailingSlot = useMemo(() => (badge ? <HostBadge badge={badge} /> : null), [badge]);
  return (
    <ComboboxItem
      label={row.entry.workspaceName}
      description={row.entry.branch || row.entry.workspaceDirectory}
      trailingSlot={trailingSlot}
      testID={`restore-project-workspace-${row.entry.workspaceId}`}
      onPress={handlePress}
    />
  );
}

type HostListingProblemKind = Exclude<ArchivedHostListing, { kind: "loaded" }>;

/** Why one host's archive is missing from the list, with a retry when loading failed. */
function HostListingProblem({
  listing,
  hostLabel,
  showHost,
  onRetry,
}: {
  listing: HostListingProblemKind;
  hostLabel: string;
  showHost: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  if (listing.kind === "disconnected") {
    return (
      <View style={styles.state}>
        <Text style={styles.hint}>
          {t("sidebar.project.archive.hostDisconnected", { host: hostLabel })}
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.state}>
      {showHost ? <Text style={styles.hostLabel}>{hostLabel}</Text> : null}
      {listing.kind === "unsupported" ? (
        <Text style={styles.hint}>{t("sidebar.project.restore.updateRequired")}</Text>
      ) : (
        <>
          <Text style={styles.hint}>{t("sidebar.project.restore.loadFailed")}</Text>
          <Text style={styles.hint}>{toErrorMessage(listing.error)}</Text>
          <Button variant="ghost" onPress={onRetry}>
            {t("common.actions.retry")}
          </Button>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  state: { padding: theme.spacing[6], gap: theme.spacing[3], alignItems: "center" },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  hostLabel: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
}));
