import { createContext, useContext, type RefObject } from "react";
import type { View } from "react-native";
export const ComposerViewportRef = createContext<RefObject<View | null> | null>(null);
/** The composer viewport view, for sticky headers that measure their position against it. */
export function useComposerViewportRef() {
  return useContext(ComposerViewportRef);
}
