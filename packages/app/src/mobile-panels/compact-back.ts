import type { MobilePanelView } from "@/stores/panel-store";

/**
 * The compact panel that Android Back shows next.
 *
 * From the agent, Back opens the sidebar, and from the explorer it returns to the agent. From the
 * open sidebar there is nothing left to close, so the press falls through to the navigator and
 * Android can leave the workspace or the app.
 *
 * @param current The compact panel showing when Back is pressed.
 * @returns The panel to show, or null to leave the press to the navigator and the system.
 */
export function resolveCompactBackTarget(current: MobilePanelView): MobilePanelView | null {
  if (current === "agent") {
    return "agent-list";
  }

  if (current === "agent-list") {
    return null;
  }

  return "agent";
}

/** Reads and changes the compact panel, so the Back policy can run without the store. */
export interface CompactPanelNavigator {
  currentTarget(): MobilePanelView;
  show(target: MobilePanelView): void;
}

/**
 * Builds a Back press handler that applies {@link resolveCompactBackTarget}.
 *
 * The handler returns true when it moved to another panel, and false when the press belongs to the
 * navigator, matching the `hardwareBackPress` contract.
 */
export function createCompactPanelBackHandler(panels: CompactPanelNavigator): () => boolean {
  return () => {
    const target = resolveCompactBackTarget(panels.currentTarget());
    if (target === null) {
      return false;
    }

    panels.show(target);
    return true;
  };
}
