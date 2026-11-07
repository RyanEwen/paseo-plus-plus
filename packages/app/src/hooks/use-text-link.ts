import { useMemo, type KeyboardEvent } from "react";
import type { GestureResponderEvent } from "react-native";
import { isWeb } from "@/constants/platform";

/** The event an actionable Text reports: a press, or Enter on the focused web element. */
export type TextLinkEvent = GestureResponderEvent | KeyboardEvent<HTMLElement>;

/**
 * Add keyboard activation to actionable Text, whose web onPress handles clicks only.
 * Native Text retains its accessibility activation through onPress. The handler receives the
 * keyboard event for Enter, so it must accept both event shapes.
 */
export function useTextLink(onPress?: (event: TextLinkEvent) => void) {
  return useMemo(
    () =>
      isWeb && onPress
        ? {
            tabIndex: 0,
            onKeyDown(event: KeyboardEvent<HTMLElement>) {
              if (event.key === "Enter") {
                event.preventDefault();
                onPress(event);
              }
            },
          }
        : {},
    [onPress],
  );
}
