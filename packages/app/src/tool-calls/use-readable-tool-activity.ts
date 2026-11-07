import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useSettings } from "@/hooks/use-settings";

/** Whether the Readable tool activity preference is on. */
export function useReadableToolActivity(): boolean {
  return useSettings((settings) => settings.paseoPlusPlus.descriptiveToolCalls);
}

/**
 * The translator for readable activity labels, or undefined while the preference is off so tool
 * call presentation keeps its classic labels.
 */
export function useReadableActivityTranslation(): TFunction | undefined {
  const readable = useReadableToolActivity();
  const { t } = useTranslation();
  return readable ? t : undefined;
}
