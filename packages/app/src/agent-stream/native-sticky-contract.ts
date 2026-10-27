import type { Animated, LayoutChangeEvent, ViewProps } from "react-native";
import type { ReactElement, Ref } from "react";
export interface NativeStickyHandle {
  setNextHeaderY(y: number): void;
}
/** RN 0.86.3 custom StickyHeaderComponent contract. Preserve layout and
 * setNextHeaderY compatibility; Android owns its translated root, while iOS
 * retains the installed RN wrapper. */
export interface NativeStickyProps {
  children: ReactElement<ViewProps & { index?: number; item?: { id: string } }>;
  nextHeaderLayoutY?: number | null;
  onLayout(event: LayoutChangeEvent): void;
  scrollAnimatedValue: Animated.Value | Animated.AnimatedAddition<number>;
  inverted?: boolean;
  scrollViewHeight?: number;
  nativeID?: string;
  hiddenOnScroll?: boolean;
  ref?: Ref<NativeStickyHandle>;
}
