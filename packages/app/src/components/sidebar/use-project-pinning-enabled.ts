import { useAppSettings } from "@/hooks/use-settings";

/** Read the Paseo++ switch that shows project pin actions, markers and priority. */
export function useProjectPinningEnabled(): boolean {
  return useAppSettings().settings.paseoPlusPlus.projectPinning;
}
