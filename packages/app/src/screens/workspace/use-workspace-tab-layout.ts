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
  /** The square icon-only tab width, or null for labelled tabs. */
  iconOnlyTabWidth: number | null;
}

interface UseWorkspaceTabLayoutResult {
  layout: WorkspaceTabLayoutResult;
}

export function useWorkspaceTabLayout(
  input: UseWorkspaceTabLayoutInput,
): UseWorkspaceTabLayoutResult {
  const { width: viewportWidth } = useWindowDimensions();
  const widerTabs = useSettings((settings) => settings.paseoPlusPlus.widerWorkspaceTabs);
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
        iconOnlyTabWidth: input.iconOnlyTabWidth ?? undefined,
      }),
    [
      input.compact,
      input.metrics,
      input.tabLabelWidths,
      resolvedViewportWidth,
      widerTabs,
      input.iconOnlyTabWidth,
    ],
  );

  return {
    layout,
  };
}
