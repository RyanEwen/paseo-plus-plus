import { describe, expect, it } from "vitest";
import {
  collectAllPanes,
  collectAllTabs,
  createDefaultLayout,
  DEFAULT_PANE_ID,
  findPaneContainingTab,
} from "@/stores/workspace-layout-actions";
import {
  createWorkspaceLayoutStore,
  type OpenWorkspaceTabInput,
} from "@/stores/workspace-layout-store";
import { createInMemoryKeyValueStorage } from "@/hooks/use-settings/fakes";
import {
  openReopenedAgentAtDestination,
  openReopenedAgentTab,
  type ReopenAgentLayoutPort,
} from "./reopen-closed-agent";

const WORKSPACE_KEY = "host:workspace";

/** A layout store double that records the opens and closes it receives. */
function recordingLayout(options: { openSucceeds?: boolean } = {}) {
  const layout = createDefaultLayout();
  const launcherTabId = collectAllTabs(layout.root)[0].tabId;
  const opened: OpenWorkspaceTabInput[] = [];
  const closed: string[] = [];
  const port: ReopenAgentLayoutPort = {
    layoutByWorkspace: { [WORKSPACE_KEY]: layout },
    openTab: (input) => {
      opened.push(input);
      return options.openSucceeds === false ? null : "agent-tab";
    },
    closeTab: (_workspaceKey, tabId) => {
      closed.push(tabId);
    },
  };
  return { port, launcherTabId, opened, closed };
}

describe("openReopenedAgentTab", () => {
  it("replaces the empty-pane launcher tab with the reopened agent", () => {
    const { port, launcherTabId, opened, closed } = recordingLayout();

    openReopenedAgentTab(
      {
        workspaceKey: WORKSPACE_KEY,
        agentId: "archived",
        destination: { kind: "replace", tabId: launcherTabId },
      },
      port,
    );

    expect(opened).toEqual([
      {
        workspaceKey: WORKSPACE_KEY,
        target: { kind: "agent", agentId: "archived" },
        intent: "reveal",
        pin: true,
        placement: { mode: "pane", paneId: DEFAULT_PANE_ID },
        insertionPosition: { afterTabId: launcherTabId },
      },
    ]);
    expect(closed).toEqual([launcherTabId]);
  });

  it("opens in the pane whose + menu was used", () => {
    const { port, opened, closed } = recordingLayout();

    openReopenedAgentTab(
      {
        workspaceKey: WORKSPACE_KEY,
        agentId: "archived",
        destination: { kind: "open", paneId: "right" },
      },
      port,
    );

    expect(opened[0].placement).toEqual({ mode: "pane", paneId: "right" });
    expect(opened[0].pin).toBe(true);
    expect(closed).toEqual([]);
  });

  it("opens in the focused pane when the menu names no pane", () => {
    const { port, opened } = recordingLayout();

    openReopenedAgentTab(
      { workspaceKey: WORKSPACE_KEY, agentId: "archived", destination: { kind: "open" } },
      port,
    );

    expect(opened[0].placement).toEqual({ mode: "focused" });
  });

  it("keeps the launcher tab when the agent could not be opened", () => {
    const { port, launcherTabId, closed } = recordingLayout({ openSucceeds: false });

    const result = openReopenedAgentTab(
      {
        workspaceKey: WORKSPACE_KEY,
        agentId: "archived",
        destination: { kind: "replace", tabId: launcherTabId },
      },
      port,
    );

    expect(result).toBeNull();
    expect(closed).toEqual([]);
  });
});

describe("openReopenedAgentAtDestination", () => {
  /** A real layout store with a file tab open in its focused pane. */
  function storeWithOnePane() {
    const store = createWorkspaceLayoutStore(undefined, createInMemoryKeyValueStorage());
    const fileTabId = store.getState().openTab({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "file", path: "/repo/keep.ts" },
      intent: "reveal",
      placement: { mode: "focused" },
    });
    if (!fileTabId) throw new Error("Expected the file tab to open");
    const layout = store.getState().layoutByWorkspace[WORKSPACE_KEY];
    const paneId = findPaneContainingTab(layout.root, fileTabId)?.id;
    if (!paneId) throw new Error("Expected the file tab's pane");
    return { store, fileTabId, paneId };
  }

  it("opens the agent alone in a new split and leaves the source pane as it was", () => {
    const { store, fileTabId, paneId } = storeWithOnePane();
    const panesBefore = collectAllPanes(store.getState().layoutByWorkspace[WORKSPACE_KEY].root);

    const agentTabId = openReopenedAgentAtDestination(
      {
        workspaceKey: WORKSPACE_KEY,
        agentId: "archived",
        destination: { kind: "split", paneId, position: "right", firstPaneFraction: 0.6 },
      },
      store,
    );

    const { root } = store.getState().layoutByWorkspace[WORKSPACE_KEY];
    expect(collectAllPanes(root)).toHaveLength(panesBefore.length + 1);
    if (!agentTabId) throw new Error("Expected the agent tab to open");
    const agentPane = findPaneContainingTab(root, agentTabId);
    expect(agentPane?.id).not.toBe(paneId);
    expect(agentPane?.tabIds).toEqual([agentTabId]);
    expect(collectAllTabs(root).find((tab) => tab.tabId === agentTabId)?.target).toEqual({
      kind: "agent",
      agentId: "archived",
    });
    expect(findPaneContainingTab(root, fileTabId)?.id).toBe(paneId);
  });

  it("opens nothing and keeps the layout when the split's target pane is gone", () => {
    const { store } = storeWithOnePane();
    const before = store.getState().layoutByWorkspace[WORKSPACE_KEY];

    const result = openReopenedAgentAtDestination(
      {
        workspaceKey: WORKSPACE_KEY,
        agentId: "archived",
        destination: {
          kind: "split",
          paneId: "closed-pane",
          position: "right",
          firstPaneFraction: 0.5,
        },
      },
      store,
    );

    expect(result).toBeNull();
    expect(store.getState().layoutByWorkspace[WORKSPACE_KEY]).toEqual(before);
  });
});
