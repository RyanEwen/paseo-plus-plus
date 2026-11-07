import { isAgentNotificationViewVisible } from "@/notifications/seen-agent";
import { usePanelStore } from "@/stores/panel-store";
import { getIsAppActivelyVisible } from "@/utils/app-visibility";
import { useEffect } from "react";
import { useAppActivelyVisible } from "@/hooks/use-app-visible";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useMobilePanelRestCheck } from "@/mobile-panels/use-mobile-panel-rest-check";
import { useIsMobilePanelActive } from "@/mobile-panels/provider";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  seenAgentNotifications,
  startSeenAgentNotifications,
} from "@/notifications/seen-agent-client";

/** Acknowledge only a painted chat in the focused pane of the foreground workspace. */
export function useSeenAgentNotifications(input: {
  serverId: string;
  agentId: string | undefined;
  focused: boolean;
  ready: boolean;
}): void {
  const foreground = useAppActivelyVisible();
  const panelVisible = useRetainedPanelActive();
  const compact = useIsCompactFormFactor();
  const { isAtRest, subscribe } = useMobilePanelRestCheck("agent");
  const centerVisible = useIsMobilePanelActive("agent");
  const centerRequested = usePanelStore((state) => state.mobilePanel.target === "agent");
  const visible = isAgentNotificationViewVisible({
    foreground,
    panelVisible,
    compact,
    centerVisible,
    centerRequested,
    focused: input.focused,
    ready: input.ready,
  });
  useEffect(() => {
    if (!visible || !input.agentId) return;
    // Panel, focus and readiness change only through renders, which re-run this effect. Window
    // focus, the requested compact pane and UI-thread motion change without one, so the lease
    // re-reads only those when a notification arrives or the panel's rest changes.
    const stopListening = startSeenAgentNotifications();
    const view = seenAgentNotifications.view({
      target: { serverId: input.serverId, agentId: input.agentId },
      isVisible: () =>
        getIsAppActivelyVisible() &&
        (!compact || (usePanelStore.getState().mobilePanel.target === "agent" && isAtRest())),
    });
    const unsubscribe = compact
      ? subscribe(() => {
          void seenAgentNotifications.refreshVisibility();
        })
      : () => {};
    return () => {
      unsubscribe();
      stopListening();
      void view.release();
    };
  }, [compact, input.agentId, input.serverId, isAtRest, subscribe, visible]);
}
