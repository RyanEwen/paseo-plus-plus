import { describe, expect, it } from "vitest";
import {
  collectAllTabs,
  createDefaultLayout,
  DEFAULT_PANE_ID,
} from "@/stores/workspace-layout-actions";
import type { OpenWorkspaceTabInput } from "@/stores/workspace-layout-store";
import { openReopenedAgentTab, type ReopenAgentLayoutPort } from "./reopen-closed-agent";

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
