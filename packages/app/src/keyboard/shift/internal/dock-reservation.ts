import { createContext, useContext } from "react";
import type { DockReservationSnapshot } from "./policy";
export const DockReservationContext = createContext<DockReservationSnapshot>({
  extent: 0,
  settledRevision: 0,
});
/** The composer dock's published keyboard reservation. */
export function useDockReservation() {
  return useContext(DockReservationContext);
}
