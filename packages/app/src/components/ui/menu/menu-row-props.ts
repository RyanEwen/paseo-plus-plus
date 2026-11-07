import { useMemo } from "react";

/** Roles a pressable menu row can take on the menu engine's keyboard navigation. */
export type MenuRowRole = "menuitem" | "checkbox";

/**
 * Props every pressable row on a menu surface needs so the engine's keyboard navigation finds it:
 * the row role, removal from the tab order (the engine moves focus itself), and the
 * `data-menu-item` / `data-menu-disabled` attributes it queries.
 */
export interface MenuRowProps {
  accessibilityRole: MenuRowRole;
  tabIndex: -1;
  dataSet: { menuItem: "true"; menuDisabled: "true" | "false" };
}

/** Build the menu row contract for one row. Pure, so it is testable without rendering. */
export function menuRowProps(input: { disabled: boolean; role?: MenuRowRole }): MenuRowProps {
  return {
    accessibilityRole: input.role ?? "menuitem",
    tabIndex: -1,
    dataSet: { menuItem: "true", menuDisabled: input.disabled ? "true" : "false" },
  };
}

/**
 * The menu row contract as a stable object for a row component. Spread it onto the row's
 * Pressable; the row keeps its own label, state, styles and press handling.
 */
export function useMenuRowProps(input: { disabled: boolean; role?: MenuRowRole }): MenuRowProps {
  const { disabled, role } = input;
  return useMemo(() => menuRowProps({ disabled, role }), [disabled, role]);
}
