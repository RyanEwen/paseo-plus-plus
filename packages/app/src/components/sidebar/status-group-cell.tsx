import { View } from "react-native";
import type { StatusGroupCellProps } from "./status-group-cell.types";

/**
 * Wrap a status-list row in its group's rows container. Native has no focus hand-off, so the view
 * only carries the `sidebar-status-group-rows-<group>` test id the web cell also renders.
 */
export function StatusGroupCell({ groupKey, children }: StatusGroupCellProps) {
  return <View testID={`sidebar-status-group-rows-${groupKey}`}>{children}</View>;
}
