import { createContext, useContext } from "react";
import { isNative } from "@/constants/platform";

/** Native viewports reserve visual-top clearance; web stays in flow. */
export const supportsStreamTopOverlay = isNative;

const StreamTopOverlayContext = createContext(0);

/** Visual-top clearance supplied by the containing layout, in points. */
export const StreamTopOverlayProvider = StreamTopOverlayContext.Provider;

export function useStreamTopOverlayInset(): number {
  return useContext(StreamTopOverlayContext);
}
