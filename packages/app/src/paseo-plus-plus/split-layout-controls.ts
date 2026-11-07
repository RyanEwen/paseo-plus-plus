import { useSettings } from "@/hooks/use-settings";

/** Whether the Paseo++ "Split layout controls" setting shows split pickers and divider presets. */
export function useSplitLayoutControlsEnabled(): boolean {
  return useSettings((settings) => settings.paseoPlusPlus.splitLayoutPresets);
}
