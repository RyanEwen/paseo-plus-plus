import type { PaneHost } from "@/panels/panel-manifest";
import { useMemo } from "react";
import { useAppSettings } from "@/hooks/use-settings";
import { useWindowDimensions } from "react-native";
import {
  computeWorkspaceTabLayout,
  type WorkspaceTabLayoutMetrics,
  type WorkspaceTabLayoutResult,
} from "@/screens/workspace/workspace-tab-layout";

interface UseWorkspaceTabLayoutInput {
  tabLabelWidths: number[];
  viewportWidthOverride?: number | null;
  metrics: WorkspaceTabLayoutMetrics;
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
  const { settings } = useAppSettings();
  const iconOnly = input.host === "explorer" && settings.explorerIconOnlyTabs;
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
        iconOnly,
        iconOnlyTabWidth: input.iconOnlyTabWidth,
      }),
    [input.metrics, input.tabLabelWidths, input.iconOnlyTabWidth, resolvedViewportWidth, iconOnly],
  );

  return {
    layout,
  };
}
