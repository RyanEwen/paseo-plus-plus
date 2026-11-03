import { useCallback, useLayoutEffect, useRef } from "react";
import { type LayoutChangeEvent, type LayoutRectangle, type View } from "react-native";

/** A rendered item's actual frame relative to the sortable list's immediate content parent. */
export interface SortableItemLayout<T> {
  item: T;
  index: number;
  frame: LayoutRectangle;
}

export type SortableItemLayoutHandler<T> = (layout: SortableItemLayout<T>) => void;

interface SortableItemLayoutInput<T> {
  item: T;
  index: number;
  /** The primitive's ordered items/keys, so unchanged indices also refresh after a reorder. */
  orderRevision: unknown;
  onItemLayout?: SortableItemLayoutHandler<T>;
}

/**
 * Measure the stable outer item root, including position-only reorders on web.
 * Callers without a layout listener keep their existing unmeasured rendering.
 */
export function useSortableItemLayout<T>({
  item,
  index,
  orderRevision,
  onItemLayout,
}: SortableItemLayoutInput<T>) {
  const ref = useRef<View | null>(null);
  const measurement = useRef(0);
  const reportFrame = useCallback(
    (frame: LayoutRectangle) => {
      // Hidden retained surfaces must not replace their last rendered geometry with zeros.
      if (frame.width <= 0 || frame.height <= 0) return;
      onItemLayout?.({ item, index, frame });
    },
    [item, index, onItemLayout],
  );

  useLayoutEffect(() => {
    const request = ++measurement.current;
    if (onItemLayout) {
      // RN web's onLayout observes size, so a surviving root also needs this read when
      // its item/index binding changes. The root stays directly inside scroll content.
      ref.current?.measure((x, y, width, height) => {
        if (request !== measurement.current) return;
        reportFrame({ x, y, width, height });
      });
    }
    return () => {
      // A completed reorder, selection, or unmount invalidates pending measurements.
      measurement.current += 1;
    };
  }, [orderRevision, onItemLayout, reportFrame]);

  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      measurement.current += 1;
      reportFrame(event.nativeEvent.layout);
    },
    [reportFrame],
  );

  return { ref, onLayout };
}
