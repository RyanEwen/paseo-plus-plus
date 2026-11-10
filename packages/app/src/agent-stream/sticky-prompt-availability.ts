import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { useSettings } from "@/hooks/use-settings";

/** Sticky prompts are desktop only: phone apps and compact layouts behave as if the
 * setting were off, with no pinning, standard previews and no navigation arrows. */
export function stickyPromptsSupported(layout: { native: boolean; compact: boolean }): boolean {
  return !layout.native && !layout.compact;
}

/** Whether this chat pins prompts and offers prompt navigation. */
export function useStickyPromptsEnabled(): boolean {
  const setting = useSettings((settings) => settings.paseoPlusPlus.stickyUserPrompts);
  const compact = useIsCompactFormFactor();
  return setting && stickyPromptsSupported({ native: isNative, compact });
}
