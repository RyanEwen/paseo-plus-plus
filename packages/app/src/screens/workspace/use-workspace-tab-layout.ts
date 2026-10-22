import type { PaneHost } from "@/panels/panel-manifest";
import { useMemo } from "react";
import { useWindowDimensions } from "react-native";
import { useSettings } from "@/hooks/use-settings";
import {
  computeWorkspaceTabLayout,
  type WorkspaceTabLayoutMetrics,
  type WorkspaceTabLayoutResult,
} from "@/screens/workspace/workspace-tab-layout";

interface UseWorkspaceTabLayoutInput {
  tabLabelWidths: number[];
  viewportWidthOverride?: number | null;
  metrics: WorkspaceTabLayoutMetrics;
  compact: boolean;
  host?: PaneHost;
  iconOnlyTabWidth?: number;
}

interface UseWorkspaceTabLayoutResult {
  layout: WorkspaceTabLayoutResult;
}

export function useWorkspaceTabLayout(
  input: UseWorkspaceTabLayoutInput,
): UseWorkspaceTabLayoutResult {
  const { width: viewportWidth } = useWindowDimensions();
  const { settings } = useSettings();
  const widerTabs = settings.paseoPlusPlus.widerWorkspaceTabs;
  const iconOnly = input.host === "explorer" && settings.paseoPlusPlus.explorerIconOnlyTabs;
  const resolvedViewportWidth =
    typeof input.viewportWidthOverride === "number" && input.viewportWidthOverride > 0
      ? input.viewportWidthOverride
      : viewportWidth;

  const layout = useMemo(
    () =>
      computeWorkspaceTabLayout({
        viewportWidth: resolvedViewportWidth,
        tabLabelWidths: input.tabLabelWidths,
        metrics: input.metrics,
        compact: input.compact,
        widerTabs,
        iconOnly,
        iconOnlyTabWidth: input.iconOnlyTabWidth,
      }),
    [
      input.metrics,
      input.tabLabelWidths,
      input.compact,
      resolvedViewportWidth,
      widerTabs,
      iconOnly,
      input.iconOnlyTabWidth,
    ],
  );

  return {
    layout,
  };
}
