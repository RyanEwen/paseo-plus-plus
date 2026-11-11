/** Accessibility props that remove a view and its children from assistive technology. */
const HIDDEN_FROM_ACCESSIBILITY = {
  accessibilityElementsHidden: true,
  importantForAccessibility: "no-hide-descendants",
  "aria-hidden": true,
} as const;

/** Accessibility props that leave a view in the accessibility tree. */
const VISIBLE_TO_ACCESSIBILITY = {
  accessibilityElementsHidden: false,
  importantForAccessibility: "auto",
  "aria-hidden": false,
} as const;

/**
 * The iOS, Android and web props that hide a view, and everything inside it, from assistive
 * technology when `hidden` is true. Spread the result onto a View; both results are constants,
 * so the props stay stable across renders.
 */
export function hiddenFromAccessibilityProps(hidden: boolean) {
  return hidden ? HIDDEN_FROM_ACCESSIBILITY : VISIBLE_TO_ACCESSIBILITY;
}
