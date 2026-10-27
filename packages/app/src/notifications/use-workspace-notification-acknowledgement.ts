import type { WorkspaceDescriptor } from "@/stores/session-store";
import { useLayoutEffect, useRef, useState } from "react";
import { useAppActivelyVisible } from "@/hooks/use-app-visible";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useIsMobilePanelActive, useMobilePanelVisibilityCheck } from "@/mobile-panels/provider";
import { usePanelStore } from "@/stores/panel-store";
import { workspaceNotificationRuntime } from "./workspace-receipts-runtime";

/** Only a selected, foreground workspace whose compact pane has settled acknowledges existing events. */
export function useWorkspaceNotificationAcknowledgement(input: {
  serverId: string;
  workspaceId: string;
  focused: boolean;
  workspace: Pick<WorkspaceDescriptor, "notificationReceipts"> | null | undefined;
}): void {
  const currentReceipts = input.workspace?.notificationReceipts;
  const foreground = useAppActivelyVisible();
  const panelVisible = useRetainedPanelActive();
  const compact = useIsCompactFormFactor();
  const centerVisible = useIsMobilePanelActive("agent");
  const centerRequested = usePanelStore((state) => state.mobilePanel.target === "agent");
  const { isAtRest, subscribe } = useMobilePanelVisibilityCheck("agent");
  const [settled, setSettled] = useState(() => isAtRest());
  useLayoutEffect(() => subscribe(() => setSettled(isAtRest())), [isAtRest, subscribe]);
  const visible =
    foreground &&
    panelVisible &&
    input.focused &&
    Boolean(currentReceipts) &&
    (!compact || (centerVisible && centerRequested && settled));
  const receipts = useRef(currentReceipts);
  receipts.current = currentReceipts;
  // Read current layout at admission without making resize a new read lease.
  const admission = useRef({ compact, isAtRest });
  admission.current = { compact, isAtRest };
  // Receipt updates while this lease is active must not create a second workspace opening.
  useLayoutEffect(() => {
    if (!visible || !receipts.current) return;
    // Motion publication can lag a new focus or receipt activation. Recheck the
    // actual pane before capturing a read boundary, then let rest retry admission.
    if (admission.current.compact && !admission.current.isAtRest()) {
      setSettled(false);
      return;
    }
    return workspaceNotificationRuntime.open(input.serverId, input.workspaceId, receipts.current);
  }, [input.serverId, input.workspaceId, visible]);
}
