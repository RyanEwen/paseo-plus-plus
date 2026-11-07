import type { ReactNode } from "react";
import type { NativeStickyProps } from "./native-sticky-contract";
/** Non-native resolution keeps model/test imports free of private RN native code.
 * Metro selects .ios/.android for the actual native wrapper; this does not emulate it. */
/** Non-native viewports have no full-row sticky handoff. */
export const NATIVE_STICKY_HANDOFF: "full-row" | undefined = undefined;

export function ActualStickyHeader({ children }: NativeStickyProps) {
  return children;
}

export function NativeActualMotionBoundary({
  children,
}: {
  allowStandalone: boolean;
  children: ReactNode;
}) {
  return children;
}
