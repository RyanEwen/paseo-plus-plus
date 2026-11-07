import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef } from "react";
import { View, type CellRendererProps, type LayoutChangeEvent } from "react-native";
import type { StreamItem } from "@/types/stream";
import type { PaintedNativeTailBinding } from "../painted-landing";
import { ActualPromptRowsContext } from "../actual-prompt-rows";
import { NativeStickyLayoutContext } from "../native-sticky-layout-context";
import {
  resolveNativeStickyHeights,
  type ActualNativeRowGeometry,
} from "../native-actual-row-model";

export const NativePaintedTailBindingContext = createContext<PaintedNativeTailBinding | null>(null);

export interface PaintedNativeRowMeasurement {
  binding: PaintedNativeTailBinding;
  item: StreamItem;
  index: number;
  height: number;
}

export interface ActualCellCallbacks {
  record(id: string, geometry: ActualNativeRowGeometry): void;
  mount(id: string, mounted: boolean): void;
  recordPainted(measurement: PaintedNativeRowMeasurement): void;
}

/** Cell type is stable across current-turn completion and history prepends. RN's
 * sticky wrapper forwards this onLayout once; children never own absolute L. */
export function createActualCellRenderer({ record, mount, recordPainted }: ActualCellCallbacks) {
  return function ActualCell({
    item,
    index,
    onLayout,
    children,
    style,
    onFocusCapture,
  }: CellRendererProps<StreamItem>) {
    const sticky = useContext(NativeStickyLayoutContext);
    const actualRowsEnabled = useContext(ActualPromptRowsContext) !== null;
    const paintedBinding = useContext(NativePaintedTailBindingContext);
    const latestLayout = useRef<LayoutChangeEvent | null>(null);
    const layoutPosition = useRef<{ id: string; index: number } | null>(null);
    const paintedReport = useRef<((event: LayoutChangeEvent) => void) | null>(null);
    useLayoutEffect(() => {
      mount(item.id, true);
      return () => mount(item.id, false);
    }, [item.id]);
    useLayoutEffect(() => {
      const report = (event: LayoutChangeEvent) => {
        if (!paintedBinding) return;
        recordPainted({
          binding: paintedBinding,
          item,
          index,
          height: event.nativeEvent.layout.height,
        });
      };
      paintedReport.current = report;
      // A committed update may retain this same physical cell without another
      // native layout event. Rebind only its held frame at the same ID/index.
      const samePosition =
        layoutPosition.current?.id === item.id && layoutPosition.current.index === index;
      if (samePosition && latestLayout.current) report(latestLayout.current);
      return () => {
        paintedReport.current = null;
      };
    }, [paintedBinding, item, index]);
    const recordCurrent = useCallback(() => {
      const layout = latestLayout.current?.nativeEvent.layout;
      if (!layout) return;
      const heights = resolveNativeStickyHeights({
        layoutHeight: layout.height,
        body: sticky?.readBody() ?? null,
      });
      record(item.id, {
        index,
        y: layout.y,
        height: layout.height,
        pinnedHeight: heights?.pinnedHeight ?? layout.height,
        fullRowReady:
          sticky?.position?.handoff === "full-row"
            ? heights !== null && sticky.readBody() !== null
            : undefined,
      });
    }, [item.id, index, sticky]);
    const measure = useCallback(
      (event: LayoutChangeEvent) => {
        event.persist();
        latestLayout.current = event;
        layoutPosition.current = { id: item.id, index };
        recordCurrent();
        paintedReport.current?.(event);
        onLayout?.(event);
      },
      [recordCurrent, onLayout, item.id, index],
    );
    useLayoutEffect(() => {
      latestLayout.current = null;
      const stopLayout = sticky?.subscribe(measure);
      // Visual-only disclosure must update collision without reporting a fake
      // flow resize to VirtualizedList or maintainVisibleContentPosition.
      const stopBody = sticky?.subscribeBody(recordCurrent);
      return () => {
        stopLayout?.();
        stopBody?.();
      };
    }, [sticky, measure, recordCurrent]);
    // RN forwards this capture callback, but its public ViewProps omits the field.
    const focusProps = useMemo(() => ({ onFocusCapture }), [onFocusCapture]);
    return (
      <View
        {...focusProps}
        onLayout={sticky ? undefined : measure}
        collapsable={false}
        pointerEvents={sticky && actualRowsEnabled ? "box-none" : undefined}
        style={[style, { overflow: "visible" }]}
      >
        {children}
      </View>
    );
  };
}
