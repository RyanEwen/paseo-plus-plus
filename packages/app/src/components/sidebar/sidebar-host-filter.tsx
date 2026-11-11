import { useCallback, useMemo, type ReactElement } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { MenuItem } from "@/components/ui/menu";
import { HostStatusDot } from "@/components/host-status-dot";
import { hostDisplayLabel } from "@/hosts/display-label";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import type { HostProfile } from "@/types/host-connection";

/** The chooser's Hosts page: All hosts, then one toggle per registered host. */
export function HostFilterPage({ hosts }: { hosts: HostProfile[] }): ReactElement {
  const { t } = useTranslation();
  const hostFilters = useSidebarViewStore((state) => state.hostFilters);
  const toggleHostFilter = useSidebarViewStore((state) => state.toggleHostFilter);
  const clearHostFilters = useSidebarViewStore((state) => state.clearHostFilters);
  return (
    <>
      <MenuItem
        selected={hostFilters.length === 0}
        closeOnSelect={false}
        onSelect={clearHostFilters}
        testID="sidebar-host-filter-all"
      >
        {t("sidebar.display.hostFilter.all")}
      </MenuItem>
      {hosts.map((host) => (
        <HostFilterItem
          key={host.serverId}
          serverId={host.serverId}
          label={hostDisplayLabel(host)}
          selected={hostFilters.includes(host.serverId)}
          onToggle={toggleHostFilter}
        />
      ))}
    </>
  );
}

/** Leads with the host's live connection dot where other option rows carry an icon. */
function HostFilterItem({
  serverId,
  label,
  selected,
  onToggle,
}: {
  serverId: string;
  label: string;
  selected: boolean;
  onToggle: (serverId: string) => void;
}): ReactElement {
  const handleSelect = useCallback(() => onToggle(serverId), [onToggle, serverId]);
  const leading = useMemo(
    () => (
      <View testID={`sidebar-host-filter-status-${serverId}`}>
        <HostStatusDot serverId={serverId} />
      </View>
    ),
    [serverId],
  );

  return (
    <MenuItem
      selected={selected}
      closeOnSelect={false}
      leading={leading}
      onSelect={handleSelect}
      testID={`sidebar-host-filter-${serverId}`}
    >
      {label}
    </MenuItem>
  );
}
