import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
  type RefObject,
} from "react";
import { useComposerViewportRef } from "@/composer/dock/internal/viewport-ref";
import { resolveNativeMotionOwner } from "./native-actual-row-model";
import type { View } from "react-native";
import type { SharedValue } from "react-native-reanimated";
import type { DockReservationSnapshot } from "@/keyboard/shift/internal/policy";
export interface NativeStickyViewport {
  y: SharedValue<number>;
}
const Context = createContext<NativeStickyViewport | null>(null);
export function NativeStickyViewportProvider({
  value,
  children,
}: {
  value: NativeStickyViewport;
  children: ReactNode;
}) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useNativeStickyViewport() {
  const value = useContext(Context);
  if (!value) throw new Error("Sticky cell requires its viewport scroll driver");
  return value;
}

/** Endpoint publication, not keyboard frames, invalidates/re-measures this reader. */
export function useNativeReadingRefresh(
  snapshot: DockReservationSnapshot,
  refresh: () => void,
  invalidate: () => void,
  measurementOwner?: NativeMeasurementContextValue,
) {
  useEffect(() => {
    refresh();
    return invalidate;
  }, [snapshot.extent, snapshot.settledRevision, refresh, invalidate, measurementOwner]);
}

export interface NativeMeasurementContextValue {
  mode: "docked" | "standalone";
  stationaryViewportRef: RefObject<View | null> | null;
}
export const NativeMeasurementContext = createContext<NativeMeasurementContextValue | null>(null);
/** Resolve this viewport's motion owner and the measurement context it publishes. */
export function useNativeMeasurementOwner(input: {
  allowStandalone: boolean;
  hasMotion: boolean;
}): NativeMeasurementContextValue {
  const stationaryViewportRef = useComposerViewportRef();
  const mode = resolveNativeMotionOwner({
    allowStandalone: input.allowStandalone,
    hasMotion: input.hasMotion,
    hasStationaryClip: stationaryViewportRef !== null,
  });
  return useMemo(() => ({ mode, stationaryViewportRef }), [mode, stationaryViewportRef]);
}

export function useNativeMeasurementContext() {
  const value = useContext(NativeMeasurementContext);
  if (!value) throw new Error("Native transcript requires its declared motion boundary");
  return value;
}
