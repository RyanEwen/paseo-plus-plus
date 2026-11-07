/** The visibility signals that decide whether an open workspace may acknowledge its events. */
export interface AcknowledgementVisibility {
  /** The app is in the foreground and actively visible. */
  foreground: boolean;
  /** The retained panel hosting this workspace is the active one. */
  panelVisible: boolean;
  /** The workspace route is focused. */
  focused: boolean;
  /** The host has delivered this workspace's receipt state. */
  hasReceipts: boolean;
  /** The layout is the compact, single-pane form. */
  compact: boolean;
  /** On compact layouts: the agent pane is the active panel. */
  centerVisible: boolean;
  /** On compact layouts: the agent pane is the requested panel target. */
  centerRequested: boolean;
  /** On compact layouts: the agent pane has settled at rest. */
  settled: boolean;
}

/** Only a selected, foreground workspace whose compact pane has settled acknowledges events. */
export function canAcknowledgeWorkspace(visibility: AcknowledgementVisibility): boolean {
  const workspaceShown =
    visibility.foreground &&
    visibility.panelVisible &&
    visibility.focused &&
    visibility.hasReceipts;
  const compactPaneSettled =
    !visibility.compact ||
    (visibility.centerVisible && visibility.centerRequested && visibility.settled);
  return workspaceShown && compactPaneSettled;
}
