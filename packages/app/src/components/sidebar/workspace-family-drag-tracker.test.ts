import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import { createFamilyDragTracker } from "./workspace-family-drag-tracker";

const SERVER_ID = "family-drag-tracker";

/** A relationship-only agent fixture: one agent per workspace, optionally under a parent agent. */
function agent(id: string, parentAgentId: string | null): Agent {
  return {
    serverId: SERVER_ID,
    id,
    workspaceId: id,
    provider: "codex",
    status: "idle",
    turn: { phase: "idle", cancellationRequestId: null },
    createdAt: new Date(0),
    updatedAt: new Date(0),
    lastUserMessageAt: null,
    lastActivityAt: new Date(0),
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: false,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: null,
    cwd: "/fixture",
    model: null,
    parentAgentId,
    labels: {},
  };
}

/** Replace one agent in the host's session, keeping every other agent's identity. */
function replaceAgent(next: Agent): void {
  const agents = new Map(useSessionStore.getState().sessions[SERVER_ID]!.agents);
  agents.set(next.id, next);
  useSessionStore.getState().setAgents(SERVER_ID, agents);
}

describe("workspace family drag tracker", () => {
  beforeEach(() => {
    const store = useSessionStore.getState();
    store.initializeSession(SERVER_ID, null);
    store.setAgents(
      SERVER_ID,
      new Map([
        ["parent", agent("parent", null)],
        ["child", agent("child", "parent")],
      ]),
    );
  });

  afterEach(() => {
    useSessionStore.getState().clearSession(SERVER_ID);
  });

  it("keeps its generation when only an agent's activity timestamp changes", () => {
    const tracker = createFamilyDragTracker([SERVER_ID]);
    const before = tracker.getSnapshot();
    replaceAgent({ ...agent("child", "parent"), lastActivityAt: new Date(1) });
    expect(tracker.getSnapshot()).toBe(before);
  });

  it("advances when an agent's parent changes", () => {
    const tracker = createFamilyDragTracker([SERVER_ID]);
    const before = tracker.getSnapshot();
    replaceAgent(agent("child", null));
    expect(tracker.getSnapshot()).toBe(before + 1);
  });

  it("advances when a saved order or a collapse choice changes", () => {
    const tracker = createFamilyDragTracker([SERVER_ID]);
    const before = tracker.getSnapshot();
    useSidebarOrderStore.getState().setStatusWorkspaceOrder([`${SERVER_ID}:child`]);
    const afterOrder = tracker.getSnapshot();
    useSidebarCollapsedSectionsStore
      .getState()
      .toggleWorkspaceGroupCollapsed(`workspace:${SERVER_ID}:parent`);
    expect(afterOrder).toBe(before + 1);
    expect(tracker.getSnapshot()).toBe(before + 2);
  });

  it("advances when its collection unsubscribes, so a held drop cannot commit", () => {
    const tracker = createFamilyDragTracker([SERVER_ID]);
    const before = tracker.getSnapshot();
    const unsubscribe = tracker.subscribe(() => undefined);
    unsubscribe();
    expect(tracker.getSnapshot()).toBe(before + 1);
  });
});
