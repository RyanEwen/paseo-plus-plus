import { describe, expect, it } from "vitest";
import type { WorkspaceTab } from "@/workspace-tabs/model";
import {
  isPreviousAgentsAvailable,
  resolveClosedAgentDialogState,
  selectPreviousAgents,
} from "./previous-agents";

function agentTab(agentId: string): WorkspaceTab {
  return { tabId: `tab-${agentId}`, createdAt: 0, target: { kind: "agent", agentId } };
}

describe("selectPreviousAgents", () => {
  it("lists agents without an open tab, whatever their runtime status", () => {
    const rows = [
      { id: "open", serverId: "host", status: "idle" },
      { id: "hidden-subagent", serverId: "host", status: "running" },
      { id: "archived", serverId: "host", status: "closed" },
    ];

    const previous = selectPreviousAgents(rows, [agentTab("open")]);

    expect(previous.map((agent) => agent.id)).toEqual(["hidden-subagent", "archived"]);
  });

  it("lists a row once when several history pages repeat it", () => {
    const row = { id: "archived", serverId: "host" };

    expect(selectPreviousAgents([row, row], [])).toEqual([row]);
  });

  it("keeps agents that share an id on different hosts", () => {
    const rows = [
      { id: "same", serverId: "host-a" },
      { id: "same", serverId: "host-b" },
    ];

    expect(selectPreviousAgents(rows, [])).toEqual(rows);
  });
});

describe("resolveClosedAgentDialogState", () => {
  const offline = [{ serverId: "host-a", serverName: "A" }];
  const ready = { hasMore: true, isError: false, hostErrors: [], isInitialLoad: false };

  it("stops cached all-open page scanning during disconnect and resumes after reconnect", () => {
    expect(
      resolveClosedAgentDialogState({
        closedAgentCount: 0,
        history: { ...ready, hostErrors: offline },
      }),
    ).toEqual({ failed: true, scanningOpenPages: false, showLoading: false });
    expect(resolveClosedAgentDialogState({ closedAgentCount: 0, history: ready })).toEqual({
      failed: false,
      scanningOpenPages: true,
      showLoading: true,
    });
  });

  it("shows failure when a held initial fetch loses its host", () => {
    expect(
      resolveClosedAgentDialogState({
        closedAgentCount: 0,
        history: { ...ready, hasMore: false, isInitialLoad: true, hostErrors: offline },
      }),
    ).toEqual({ failed: true, scanningOpenPages: false, showLoading: false });
  });

  it("shows fresh offline failure without inventing progress", () => {
    expect(
      resolveClosedAgentDialogState({
        closedAgentCount: 0,
        history: { ...ready, hasMore: false, hostErrors: offline },
      }),
    ).toEqual({ failed: true, scanningOpenPages: false, showLoading: false });
  });

  it("keeps cached closed rows visible during failure and reconnect", () => {
    expect(
      resolveClosedAgentDialogState({
        closedAgentCount: 1,
        history: { ...ready, hostErrors: offline },
      }),
    ).toEqual({ failed: true, scanningOpenPages: false, showLoading: false });
  });
});

describe("isPreviousAgentsAvailable", () => {
  const available = { serverId: "host", workspaceId: "workspace", readReady: true, enabled: true };

  it("offers the dialog once settings are read and the setting is on", () => {
    expect(isPreviousAgentsAvailable(available)).toBe(true);
  });

  it("waits for settings to be read before trusting the default", () => {
    expect(isPreviousAgentsAvailable({ ...available, readReady: false })).toBe(false);
  });

  it("hides the dialog while the setting is off", () => {
    expect(isPreviousAgentsAvailable({ ...available, enabled: false })).toBe(false);
  });

  it("needs a workspace to scope the history to", () => {
    expect(isPreviousAgentsAvailable({ ...available, workspaceId: " " })).toBe(false);
    expect(isPreviousAgentsAvailable({ ...available, serverId: "" })).toBe(false);
  });
});
