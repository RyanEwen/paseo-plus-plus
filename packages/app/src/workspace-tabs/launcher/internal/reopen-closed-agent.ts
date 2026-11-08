import {
  FOCUSED_PANE_PLACEMENT,
  findPaneContainingTab,
  type WorkspaceLayout,
  type WorkspaceTabPlacement,
} from "@/stores/workspace-layout-actions";
import type { OpenWorkspaceTabInput } from "@/stores/workspace-layout-store";
import type { WorkspaceTabLaunchDestination } from "../index";
import {
  resolveWorkspaceTabLaunchDestination,
  type LaunchDestinationLayoutOwner,
} from "./destination";

/** The layout store operations reopening an agent needs; the real store satisfies it. */
export interface ReopenAgentLayoutPort {
  layoutByWorkspace: Readonly<Record<string, WorkspaceLayout | undefined>>;
  openTab: (input: OpenWorkspaceTabInput) => string | null;
  closeTab: (workspaceKey: string, tabId: string) => void;
}

/** A launch destination after any split has become its placeholder tab (see `destination.ts`). */
type ReopenAgentDestination = Exclude<WorkspaceTabLaunchDestination, { kind: "split" }>;

/** The live layout store: the split is created first, so later reads must see the new pane. */
export interface ReopenAgentLayoutOwner {
  getState(): ReopenAgentLayoutPort & ReturnType<LaunchDestinationLayoutOwner["getState"]>;
}

/**
 * Open a picked agent at the destination its dialog was launched for.
 *
 * Call this only once an agent is picked: a split destination creates its empty pane here, so a
 * cancelled dialog never changes the layout. That pane's launcher tab then acts as a `replace`
 * destination, which puts the agent in the new pane and closes the launcher tab.
 *
 * @returns The opened agent tab id, or null when the split could not be created (its target pane
 *   is gone or the layout is at its depth limit) or the store refused the open.
 */
export function openReopenedAgentAtDestination(
  input: {
    workspaceKey: string;
    agentId: string;
    destination: WorkspaceTabLaunchDestination;
  },
  owner: ReopenAgentLayoutOwner,
): string | null {
  const { workspaceKey, agentId, destination } = input;
  const resolved = resolveWorkspaceTabLaunchDestination(workspaceKey, destination, owner);
  if (!resolved) {
    return null;
  }

  return openReopenedAgentTab({ workspaceKey, agentId, destination: resolved }, owner.getState());
}

/**
 * Open an agent picked in the Reopen closed agent dialog where the user launched the dialog.
 *
 * The tab is pinned, so an archived agent or a hidden subagent stays open instead of being
 * pruned by tab reconciliation. A `replace` destination is the empty-pane launcher tab: the
 * agent opens in that tab's pane and slot, then the launcher tab closes. An `open`
 * destination opens the agent in the given pane, or the focused pane when none is given.
 *
 * @returns The opened agent tab id, or null when the layout store refused the open (the
 *   launcher tab is then left in place).
 */
export function openReopenedAgentTab(
  input: {
    workspaceKey: string;
    agentId: string;
    destination: ReopenAgentDestination;
  },
  layout: ReopenAgentLayoutPort,
): string | null {
  const { workspaceKey, agentId, destination } = input;
  const open: OpenWorkspaceTabInput = {
    workspaceKey,
    target: { kind: "agent", agentId },
    intent: "reveal",
    pin: true,
    placement: resolvePlacement(workspaceKey, destination, layout),
  };
  if (destination.kind === "replace") {
    open.insertionPosition = { afterTabId: destination.tabId };
  }

  const openedTabId = layout.openTab(open);
  if (openedTabId && destination.kind === "replace") {
    layout.closeTab(workspaceKey, destination.tabId);
  }
  return openedTabId;
}

/** The pane the user launched from: the launcher tab's pane, the given pane, or the focused one. */
function resolvePlacement(
  workspaceKey: string,
  destination: ReopenAgentDestination,
  layout: ReopenAgentLayoutPort,
): WorkspaceTabPlacement {
  if (destination.kind === "open") {
    return destination.paneId
      ? { mode: "pane", paneId: destination.paneId }
      : FOCUSED_PANE_PLACEMENT;
  }
  const root = layout.layoutByWorkspace[workspaceKey]?.root;
  const pane = root ? findPaneContainingTab(root, destination.tabId) : null;
  return pane ? { mode: "pane", paneId: pane.id } : FOCUSED_PANE_PLACEMENT;
}
