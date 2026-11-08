import { useTranslation } from "react-i18next";
import { hostSupportsFeature } from "@/runtime/host-features";
import { useSessionStore, type DaemonServerInfo } from "@/stores/session-store";

/**
 * Whether a host is known to be too old for project pins.
 *
 * A host that has not reported its server info yet is not blocked: an offline row must not tell
 * the user to update a host whose version is unknown.
 */
export function isProjectPinBlockedByHost(
  serverInfo: DaemonServerInfo | null | undefined,
): boolean {
  return serverInfo != null && !hostSupportsFeature(serverInfo, "projectWorkspacePinning");
}

/**
 * Menu item state for the project pin action on one host.
 *
 * @param serverId the workspace's host, when the menu knows it.
 * @returns `disabled` and the update reason to show up front; the reason is undefined when enabled.
 */
export function useProjectPinAvailability(serverId: string | undefined): {
  disabled: boolean;
  description: string | undefined;
} {
  const { t } = useTranslation();
  const blocked = useSessionStore((state) =>
    isProjectPinBlockedByHost(serverId ? state.sessions[serverId]?.serverInfo : null),
  );
  return {
    disabled: blocked,
    description: blocked ? t("sidebar.workspace.toasts.updateHostToPinInProject") : undefined,
  };
}
