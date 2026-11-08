/**
 * The web runtime hook on a status group header. Focus hand-off finds a header through this data
 * attribute, so it does not depend on test ids.
 */
export function statusGroupHeaderDataSet(groupKey: string): { sidebarStatusGroupKey: string } {
  return { sidebarStatusGroupKey: groupKey };
}

/**
 * The selector for one status group header. Web only by default: `escape` is `CSS.escape`, and
 * must be passed where that global does not exist.
 */
export function statusGroupHeaderSelector(
  groupKey: string,
  escape: (value: string) => string = CSS.escape,
): string {
  return `[data-sidebar-status-group-key="${escape(groupKey)}"]`;
}
