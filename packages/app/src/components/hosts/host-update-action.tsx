import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { HostProfile } from "@/types/host-connection";
import {
  isHostUpdateOffered,
  shouldCheckHostUpdate,
  type HostUpdateRowState,
  type HostUpdateSupport,
} from "./host-update-eligibility";

interface HostUpdateActionProps {
  host: HostProfile;
  updateSupport: HostUpdateSupport;
  daemonVersion: string | null;
  /** The host menu is open; the row checks availability only while it is. */
  enabled: boolean;
  /** Another sidebar update is running; the action stays visible but disabled. */
  busy: boolean;
  onUpdate: (host: HostProfile) => void;
}

/** Footer-only action: failures and unknown eligibility never become an update invitation. */
export function HostUpdateAction({
  host,
  updateSupport,
  daemonVersion,
  enabled,
  busy,
  onUpdate,
}: HostUpdateActionProps) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(host.serverId);
  const connected = useHostRuntimeIsConnected(host.serverId);
  const row: HostUpdateRowState = {
    support: updateSupport,
    enabled,
    connected,
    hasClient: client !== null,
  };

  const query = useFetchQuery({
    queryKey: ["daemon-update-availability", host.serverId, daemonVersion],
    enabled: shouldCheckHostUpdate(row),
    queryFn: async () => {
      if (!client) throw new Error("Host disconnected");
      return client.checkDaemonUpdateAvailability();
    },
    dataShape: "value",
    staleTimeMs: 0,
    retry: false,
  });
  const offered = isHostUpdateOffered(row, {
    settled: !query.isFetching && !query.isError,
    version: query.data?.version ?? null,
  });

  const handleUpdate = useCallback(
    (event: { stopPropagation: () => void }) => {
      event.stopPropagation();
      onUpdate(host);
    },
    [host, onUpdate],
  );
  if (!offered) return null;

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={busy}
      accessibilityLabel={t("settings.host.daemon.update.confirmTitle", { name: host.label })}
      testID={`sidebar-host-update-${host.serverId}`}
      onPress={handleUpdate}
    >
      {t("settings.host.daemon.update.confirm")}
    </Button>
  );
}
