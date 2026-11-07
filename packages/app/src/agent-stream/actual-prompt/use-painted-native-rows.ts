import { useMemo, useRef } from "react";
import type { PaintedNativeTailBinding, PaintedNativeTailRow } from "../painted-landing";
import type { PaintedNativeRowMeasurement } from "./native-actual-cell";

/**
 * The positive painted frames reported by native cells, keyed by row id. Each frame belongs
 * to the binding it was measured under, so a later binding never reuses an earlier frame.
 */
export function usePaintedNativeRows() {
  const rows = useRef(new Map<string, PaintedNativeTailRow>());
  return useMemo(
    () => ({
      clear() {
        rows.current.clear();
      },
      /** A departed cell's frame no longer describes painted content. */
      forget(id: string) {
        rows.current.delete(id);
      },
      /**
       * Record one cell frame. Returns true when it was recorded as positive paint; a later
       * zero or invalid frame instead invalidates that binding's earlier positive frame.
       */
      record({ binding, item, index, height }: PaintedNativeRowMeasurement): boolean {
        if (binding.items[index] !== item) return false;
        if (!(height > 0) || !Number.isFinite(height)) {
          if (rows.current.get(item.id)?.binding === binding) rows.current.delete(item.id);
          return false;
        }
        rows.current.set(item.id, { binding, id: item.id, index, height, mounted: true });
        return true;
      },
      /** The first mounted row painted under `binding` at its current index, if any. */
      find(
        binding: PaintedNativeTailBinding,
        mountedIds: Iterable<string>,
      ): PaintedNativeTailRow | null {
        for (const id of mountedIds) {
          const row = rows.current.get(id);
          if (row?.binding === binding && row.height > 0 && binding.items[row.index]?.id === id) {
            return row;
          }
        }
        return null;
      },
    }),
    [],
  );
}
