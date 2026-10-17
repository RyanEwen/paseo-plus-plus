import { useMemo } from "react";
import { useSettings } from "@/hooks/use-settings";
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
  preserveNaturalWidths?: boolean;
  host?: "main" | "explorer";
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
        preserveNaturalWidths: input.preserveNaturalWidths,
        iconOnly,
        iconOnlyTabWidth: input.iconOnlyTabWidth,
      }),
    [
      input.metrics,
      input.tabLabelWidths,
      input.preserveNaturalWidths,
      resolvedViewportWidth,
      iconOnly,
      input.iconOnlyTabWidth,
    ],
  );

  return {
    layout,
  };
}
