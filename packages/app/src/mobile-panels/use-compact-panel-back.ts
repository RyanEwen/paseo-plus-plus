import { useEffect } from "react";
import { systemBackPress } from "@/components/ui/isolated-bottom-sheet-modal/back-press";
import { usePanelStore, type MobilePanelView } from "@/stores/panel-store";
import { createCompactPanelBackHandler } from "./compact-back";

/** Shows a compact panel through the panel store's semantic actions. */
function showCompactPanel(target: MobilePanelView): void {
  const panels = usePanelStore.getState();

  if (target === "agent-list") {
    panels.showMobileAgentList();
    return;
  }

  if (target === "file-explorer") {
    panels.showMobileFileExplorer();
    return;
  }

  panels.showMobileAgent();
}

/**
 * Lets Android Back walk the compact workspace panels (see `resolveCompactBackTarget`).
 *
 * Back is handled only while the workspace route is focused and the layout is compact. Wide layouts
 * render the explorer as a tab and have no panel to return to, so Back there belongs to the
 * navigator. The subscription is Android-only through `systemBackPress`; sheets subscribed later
 * take Back first.
 *
 * @param input.routeFocused Whether the workspace route is focused.
 * @param input.compact Whether the compact (phone) layout is active.
 */
export function useCompactPanelBack(input: { routeFocused: boolean; compact: boolean }): void {
  const enabled = input.routeFocused && input.compact;

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const handleBack = createCompactPanelBackHandler({
      currentTarget: () => usePanelStore.getState().mobilePanel.target,
      show: showCompactPanel,
    });

    return systemBackPress.subscribe(handleBack);
  }, [enabled]);
}
