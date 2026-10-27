/**
 * @vitest-environment jsdom
 */
import { act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  AgentSnapshotPayloadSchema,
  WorkspaceDescriptorPayloadSchema,
  type AgentSnapshotPayload,
  type WorkspaceScriptPayload,
} from "@getpaseo/protocol/messages";
import { parentAddressLabels } from "@getpaseo/protocol/agent-labels";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { useMemo } from "react";
import type { ReactElement } from "react";
import { createProjectViewKey } from "@/projects/workspace-structure";
import { ProjectArchiveBackgroundDialog } from "@/workspace/project-archive-background-dialog";
import type { ProjectArchiveWorkspace } from "@/workspace/project-workspace-archive";
import type { AdaptiveModalSheetProps } from "@/components/adaptive-modal-sheet";

// Keep the owning domain's confirmation and controls real; native sheet placement is a separate check.
vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveModalSheet: ({ header, children, footer, onClose, testID }: AdaptiveModalSheetProps) => (
    <div role="dialog" aria-label={header.title} data-testid={testID}>
      {children}
      {footer}
      <button type="button" data-testid="project-archive-dismiss" onClick={onClose}>
        Close
      </button>
    </div>
  ),
}));

// Preserve real animation builders imported by shared menus; only fixture animations are immediate.
vi.mock("react-native-reanimated", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-native-reanimated")>();
  return {
    ...actual,
    default: {
      ...actual.default,
      View: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
    },
    Easing: { ease: "ease", inOut: (value: unknown) => value },
    interpolateColor: (value: number, _input: number[], output: string[]) =>
      value >= 1 ? output[1] : output[0],
    useAnimatedStyle: (factory: () => unknown) => factory(),
    useDerivedValue: (factory: () => unknown) => ({ value: factory() }),
    withTiming: (value: unknown) => value,
  };
});

vi.hoisted(() => {
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
});

const pathnameState = vi.hoisted(() => ({
  value: "/",
}));

vi.mock("expo-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("expo-router")>();
  return {
    ...actual,
    router: {
      ...actual.router,
      dismissTo: vi.fn(),
    },
    useLocalSearchParams: () => ({}),
    usePathname: () => pathnameState.value,
  };
});

import {
  createSidebarWorkspaceEntry,
  type SidebarProjectEntry,
  type SidebarWorkspaceEntry,
  type SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import { useSidebarWorkspacesList } from "@/hooks/use-sidebar-workspaces-list";
import {
  getHostRuntimeStore,
  type HostRuntimeController,
  type HostRuntimeSnapshot,
} from "@/runtime/host-runtime";
import type { HostProfile } from "@/types/host-connection";
import { useSessionStore, type Agent, type WorkspaceDescriptor } from "@/stores/session-store";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import {
  SidebarWorkspaceTreeProvider,
  useSidebarWorkspaceTree,
  type SidebarWorkspaceTreeModel,
  type WorkspaceFamilyDragAuthority,
} from "./sidebar/workspace-tree-context";
import {
  useWorkspaceFamilyDrag,
  useWorkspaceFamilyDragAuthority,
} from "./sidebar/use-workspace-family-drag";
import {
  effectiveWorkspaceCollapse,
  workspaceCollapseKey,
  type WorkspaceTreeNode,
} from "./sidebar/workspace-tree";
import { WorkspaceTreeBranch } from "./sidebar/workspace-tree-branch";
import { SidebarModelProvider, useSidebarModel } from "./sidebar/sidebar-model";
import { workspaceFamilyRoots } from "./sidebar/workspace-tree";
import { resolveSidebarWorkspacePrimaryLabel } from "./sidebar/sidebar-workspace-title";
import type { DraggableRenderItemInfo } from "./draggable-list";
import { i18n as sidebarI18n } from "@/i18n/i18next";
import { seedRuntimeWorkspaces } from "@/test/seed-session";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import { useWorkspaceFields } from "@/stores/session-store-hooks";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { defaultHostAppearance } from "@/hosts/appearance";
import { useSidebarQuickFilterStore } from "@/stores/sidebar-quick-filter-store";
import {
  navigateToWorkspace,
  getLastWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { DEFAULT_CLIENT_SETTINGS } from "@/hooks/use-settings";
import { APP_SETTINGS_QUERY_KEY } from "@/hooks/use-settings/storage";
import { resolveProjectWorkspaceReorder } from "@/utils/sidebar-reorder";
import { AgentDirectoryReplica } from "@/runtime/directory-sync/agent-replica";
import { WorkspaceDirectoryReplica } from "@/runtime/directory-sync/workspace-replica";
import { projectAgentSnapshot } from "@/utils/agent-snapshots";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}));

const SERVER_ID = "sidebar-render-count";

interface RenderCounts {
  frame: number;
  headers: Record<string, number>;
  rows: Record<string, number>;
  projectSelection: Record<string, number>;
  rowSelection: Record<string, number>;
}

const runningScript: WorkspaceScriptPayload = {
  scriptName: "web",
  type: "service",
  hostname: "web.paseo.localhost",
  port: 3000,
  proxyUrl: "http://web.paseo.localhost:6767",
  lifecycle: "running",
  health: "healthy",
  exitCode: null,
  terminalId: null,
};

function workspace(input: {
  id: string;
  projectId: string;
  projectDisplayName: string;
  name: string;
  status?: WorkspaceDescriptor["status"];
  scripts?: WorkspaceDescriptor["scripts"];
}): WorkspaceDescriptor {
  return {
    id: input.id,
    projectId: input.projectId,
    projectDisplayName: input.projectDisplayName,
    projectRootPath: `/repo/${input.projectId}`,
    workspaceDirectory: `/repo/${input.projectId}/${input.id}`,
    projectKind: "git",
    workspaceKind: input.name === "main" ? "local_checkout" : "worktree",
    name: input.name,
    status: input.status ?? "done",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    scripts: input.scripts ?? [],
  };
}

function createWorkspaces(): WorkspaceDescriptor[] {
  return [
    workspace({
      id: "a-main",
      projectId: "project-a",
      projectDisplayName: "Project A",
      name: "main",
      scripts: [runningScript],
    }),
    workspace({
      id: "a-one",
      projectId: "project-a",
      projectDisplayName: "Project A",
      name: "one",
    }),
    workspace({
      id: "a-two",
      projectId: "project-a",
      projectDisplayName: "Project A",
      name: "two",
    }),
    workspace({
      id: "b-main",
      projectId: "project-b",
      projectDisplayName: "Project B",
      name: "main",
    }),
    workspace({
      id: "b-one",
      projectId: "project-b",
      projectDisplayName: "Project B",
      name: "one",
    }),
    workspace({
      id: "b-two",
      projectId: "project-b",
      projectDisplayName: "Project B",
      name: "two",
    }),
  ];
}

function makeHost(): HostProfile {
  const now = "2026-04-19T00:00:00.000Z";
  return {
    serverId: SERVER_ID,
    label: "Render Count Host",
    appearance: defaultHostAppearance(),
    lifecycle: {},
    connections: [],
    preferredConnectionId: null,
    createdAt: now,
    updatedAt: now,
  };
}

function setHostProfiles(hosts: HostProfile[]): void {
  (
    getHostRuntimeStore() as unknown as {
      setHostsAndSync: (hosts: HostProfile[]) => void;
    }
  ).setHostsAndSync(hosts);
}

function initializeSidebarState(workspaces: WorkspaceDescriptor[]): void {
  act(() => {
    setHostProfiles([makeHost()]);
    useSessionStore.getState().initializeSession(SERVER_ID, null as unknown as DaemonClient);
    seedRuntimeWorkspaces(SERVER_ID, new Map(workspaces.map((entry) => [entry.id, entry])));
    useSessionStore.getState().setHasHydratedWorkspaces(SERVER_ID, true);
    useSidebarOrderStore.setState({
      projectOrder: ["project-a", "project-b"],
      workspaceOrderByProject: {
        ["project-a"]: [`${SERVER_ID}:a-main`, `${SERVER_ID}:a-one`, `${SERVER_ID}:a-two`],
        ["project-b"]: [`${SERVER_ID}:b-main`, `${SERVER_ID}:b-one`, `${SERVER_ID}:b-two`],
      },
    });
  });
}

function resetCounts(counts: RenderCounts): void {
  counts.frame = 0;
  counts.headers = {};
  counts.rows = {};
  counts.projectSelection = {};
  counts.rowSelection = {};
}

function incrementRecord(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

function ProjectHeaderProbe({
  project,
  counts,
}: {
  project: SidebarProjectEntry;
  counts: RenderCounts;
}): null {
  incrementRecord(counts.headers, project.viewKey);
  return null;
}

function WorkspaceRowProbe({
  serverId,
  workspaceId,
  counts,
}: {
  serverId: string;
  workspaceId: string;
  counts: RenderCounts;
}): null {
  const workspaceEntry = useWorkspaceFields(serverId, workspaceId, (entry) =>
    createSidebarWorkspaceEntry({ serverId, workspace: entry }),
  );
  if (workspaceEntry) {
    incrementRecord(counts.rows, workspaceEntry.workspaceId);
  }
  return null;
}

function ProjectActiveProbe({
  serverId,
  project,
  counts,
}: {
  serverId: string;
  project: SidebarProjectEntry;
  counts: RenderCounts;
}): null {
  const activeSelection = useActiveWorkspaceSelection();
  const isActive =
    activeSelection?.serverId === serverId &&
    project.workspaces.some((entry) => entry.workspaceId === activeSelection.workspaceId);
  void isActive;
  incrementRecord(counts.projectSelection, project.viewKey);
  return null;
}

function WorkspaceSelectionProbe({
  serverId,
  workspaceId,
  counts,
}: {
  serverId: string;
  workspaceId: string;
  counts: RenderCounts;
}): null {
  const activeSelection = useActiveWorkspaceSelection();
  const selected =
    activeSelection?.serverId === serverId && activeSelection.workspaceId === workspaceId;
  void selected;
  incrementRecord(counts.rowSelection, workspaceId);
  return null;
}

function SidebarFrameProbe({ counts }: { counts: RenderCounts }): ReactElement {
  counts.frame += 1;
  const { projects } = useSidebarWorkspacesList({ hostFilters: [SERVER_ID] });

  return (
    <>
      {projects.map((project) => (
        <div key={project.viewKey}>
          <ProjectHeaderProbe project={project} counts={counts} />
          <ProjectActiveProbe serverId={SERVER_ID} project={project} counts={counts} />
          {project.workspaces.map((entry) => (
            <React.Fragment key={entry.workspaceKey}>
              <WorkspaceRowProbe
                serverId={entry.serverId}
                workspaceId={entry.workspaceId}
                counts={counts}
              />
              <WorkspaceSelectionProbe
                serverId={entry.serverId}
                workspaceId={entry.workspaceId}
                counts={counts}
              />
            </React.Fragment>
          ))}
        </div>
      ))}
    </>
  );
}

function getHostController(): HostRuntimeController {
  const controllers = (
    getHostRuntimeStore() as unknown as {
      controllers: Map<string, HostRuntimeController>;
    }
  ).controllers;
  const controller = controllers.get(SERVER_ID);
  if (!controller) {
    throw new Error("Host runtime controller was not initialized");
  }
  return controller;
}

function updateControllerSnapshot(
  patch: Partial<Omit<HostRuntimeSnapshot, "serverId" | "clientGeneration">>,
): void {
  (
    getHostController() as unknown as {
      updateSnapshot: (
        patch: Partial<Omit<HostRuntimeSnapshot, "serverId" | "clientGeneration">>,
      ) => void;
    }
  ).updateSnapshot(patch);
}

async function renderProbe(counts: RenderCounts): Promise<{ root: Root; container: HTMLElement }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    renderSidebarFrame(root, counts);
  });
  resetCounts(counts);
  return { root, container };
}

function renderSidebarFrame(root: Root, counts: RenderCounts) {
  root.render(<SidebarFrameProbe counts={counts} />);
}

describe("sidebar workspace render isolation", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(async () => {
    initializeSidebarState(createWorkspaces());
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    root = null;
    container?.remove();
    container = null;
    act(() => {
      pathnameState.value = "/";
      setHostProfiles([]);
      useSessionStore.getState().clearSession(SERVER_ID);
      useSidebarOrderStore.setState({
        projectOrder: [],
        workspaceOrderByProject: {},
      });
    });
  });

  it("re-renders only the changed workspace row for a status update", async () => {
    const counts: RenderCounts = {
      frame: 0,
      headers: {},
      rows: {},
      projectSelection: {},
      rowSelection: {},
    };
    ({ root, container } = await renderProbe(counts));

    act(() => {
      useSessionStore.getState().mergeWorkspaces(SERVER_ID, [
        {
          ...createWorkspaces()[1],
          status: "running",
        },
      ]);
    });

    expect(counts.frame).toBe(0);
    expect(counts.headers).toEqual({});
    expect(counts.rows).toEqual({ "a-one": 1 });
  });

  it("does not re-render the sidebar for a host-runtime probe tick with no content change", async () => {
    const counts: RenderCounts = {
      frame: 0,
      headers: {},
      rows: {},
      projectSelection: {},
      rowSelection: {},
    };
    ({ root, container } = await renderProbe(counts));

    act(() => {
      const probeByConnectionId = getHostController().getSnapshot().probeByConnectionId;
      updateControllerSnapshot({
        probeByConnectionId: new Map(probeByConnectionId),
      });
    });

    expect(counts).toEqual({
      frame: 0,
      headers: {},
      rows: {},
      projectSelection: {},
      rowSelection: {},
    });
  });

  it("updates active selection probes from the active workspace route", async () => {
    const counts: RenderCounts = {
      frame: 0,
      headers: {},
      rows: {},
      projectSelection: {},
      rowSelection: {},
    };

    act(() => {
      pathnameState.value = `/h/${SERVER_ID}/workspace/a-one`;
    });
    ({ root, container } = await renderProbe(counts));

    act(() => {
      pathnameState.value = `/h/${SERVER_ID}/workspace/b-two`;
      if (root) {
        renderSidebarFrame(root, counts);
      }
    });

    expect(counts.frame).toBe(1);
    expect(counts.projectSelection).toEqual({
      [createProjectViewKey({ kind: "equivalence", projectKey: "project-a" })]: 1,
      [createProjectViewKey({ kind: "equivalence", projectKey: "project-b" })]: 1,
    });
    expect(counts.rowSelection).toEqual({
      "a-main": 1,
      "a-one": 1,
      "a-two": 1,
      "b-main": 1,
      "b-one": 1,
      "b-two": 1,
    });
  });
});

describe("project Archive all background confirmation", () => {
  let root: Root;
  let container: HTMLDivElement;
  const choose = vi.fn<(includeBackground: boolean | null) => void>();
  const ordinary: ProjectArchiveWorkspace = {
    serverId: "host-a",
    workspaceId: "ordinary",
    workspaceKind: "local_checkout",
    name: "main",
    background: false,
    agentIds: ["ordinary-agent"],
    runningAgentCount: 1,
    archiveHasUncommittedChanges: null,
    archiveUnpushedCommitCount: null,
    diffStat: null,
  };
  const background: ProjectArchiveWorkspace = {
    ...ordinary,
    workspaceId: "background",
    background: true,
    agentIds: ["job", "child"],
  };

  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    choose.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root.render(
        <ProjectArchiveBackgroundDialog
          projectName="Paseo++"
          hostCount={2}
          workspaces={[ordinary, background]}
          onChoose={choose}
        />,
      ),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function click(testID: string): void {
    const control = container.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
    expect(Boolean(control)).toBe(true);
    act(() => control?.click());
  }

  it("starts unchecked with ordinary counts, and updates counts after explicit accessible opt-in", () => {
    const toggle = container.querySelector('[role="switch"]');
    expect(toggle?.getAttribute("aria-checked")).toBe("false");
    expect(toggle?.getAttribute("aria-label")).toBe("Also archive background workspaces (1)");
    expect(container.textContent).toContain("Workspaces: 1");
    expect(container.textContent).toContain("Agents: 1 (running: 1)");
    expect(container.textContent).toContain("stops their agents and jobs too");
    expect(choose).not.toHaveBeenCalled();

    click("project-archive-include-background");
    expect(container.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).toContain("Workspaces: 2");
    expect(container.textContent).toContain("Agents: 3 (running: 2)");
    click("project-archive-confirm");
    expect(choose.mock.calls).toEqual([[true]]);
  });

  it("confirms only ordinary workspaces when the switch remains off", () => {
    click("project-archive-confirm");
    expect(choose.mock.calls).toEqual([[false]]);
  });

  it.each(["project-archive-cancel", "project-archive-dismiss"])(
    "%s cancels even after opt-in",
    (testID) => {
      click("project-archive-include-background");
      click(testID);
      expect(choose.mock.calls).toEqual([[null]]);
    },
  );
});

const FAMILY_DRAG_SERVER_ID = "sidebar-family-drag";
const FAMILY_DRAG_SERVER_IDS = [FAMILY_DRAG_SERVER_ID];
const FAMILY_DRAG_SCOPE = "family-project";
const FAMILY_DRAG_ORDER = [
  "sidebar-family-drag:parent",
  "sidebar-family-drag:a",
  "sidebar-family-drag:b",
];
const FAMILY_DRAG_REORDERED = [
  "sidebar-family-drag:parent",
  "sidebar-family-drag:b",
  "sidebar-family-drag:a",
];
const FAMILY_DRAG_TREE = new Map<string, WorkspaceTreeNode>([
  [
    "sidebar-family-drag:parent",
    {
      parentKey: null,
      childKeys: ["sidebar-family-drag:a", "sidebar-family-drag:b"],
      descendantKeys: ["sidebar-family-drag:a", "sidebar-family-drag:b"],
    },
  ],
  [
    "sidebar-family-drag:a",
    { parentKey: "sidebar-family-drag:parent", childKeys: [], descendantKeys: [] },
  ],
  [
    "sidebar-family-drag:b",
    { parentKey: "sidebar-family-drag:parent", childKeys: [], descendantKeys: [] },
  ],
]);

interface FamilyDragProbe {
  guard: ReturnType<typeof useWorkspaceFamilyDrag> | null;
  authority: WorkspaceFamilyDragAuthority | null;
  renders: number;
}

/** Keep a rendered A/B-under-P projection while a queued drop races a real store update. */
function WorkspaceFamilyDragProbe({
  probe,
  serverIds,
}: {
  probe: FamilyDragProbe;
  serverIds: readonly string[];
}) {
  const authority = useWorkspaceFamilyDragAuthority(serverIds);
  const value = useMemo<SidebarWorkspaceTreeModel>(
    () => ({
      tree: FAMILY_DRAG_TREE,
      revision: "a-and-b-under-parent",
      dragAuthority: authority,
      collapsedKeys: new Set(),
      activeWorkspaceKey: null,
      entries: new Map(),
      humanAttentionWorkspaceKeys: new Set(),
    }),
    [authority],
  );
  probe.authority = authority;
  return (
    <SidebarWorkspaceTreeProvider value={value}>
      <WorkspaceFamilyDropProbe probe={probe} />
    </SidebarWorkspaceTreeProvider>
  );
}

function WorkspaceFamilyDropProbe({ probe }: { probe: FamilyDragProbe }): null {
  probe.renders += 1;
  probe.guard = useWorkspaceFamilyDrag();
  return null;
}

/** Full real-store fixture, with only lifetime parentage varied between queued callbacks. */
function familyDragAgent(id: string, parentAgentId: string | null): Agent {
  return {
    serverId: FAMILY_DRAG_SERVER_ID,
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

describe("workspace family queued-drop authority", () => {
  let root: Root;
  let container: HTMLElement;
  let probe: FamilyDragProbe;
  let previousView: ReturnType<typeof useSidebarViewStore.getState>;
  let previousCollapse: ReturnType<typeof useSidebarCollapsedSectionsStore.getState>;
  let previousOrder: ReturnType<typeof useSidebarOrderStore.getState>;

  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    previousView = useSidebarViewStore.getState();
    previousCollapse = useSidebarCollapsedSectionsStore.getState();
    previousOrder = useSidebarOrderStore.getState();
    useSidebarViewStore.setState({ groupMode: "project", workspaceSortMode: "custom" });
    useSidebarCollapsedSectionsStore.setState({
      collapsedProjectKeys: new Set(),
      collapsedWorkspaceGroupKeys: new Set(),
      collapsedPinned: false,
    });
    useSidebarOrderStore.getState().setWorkspaceOrder(FAMILY_DRAG_SCOPE, FAMILY_DRAG_ORDER);
    const session = useSessionStore.getState();
    session.initializeSession(FAMILY_DRAG_SERVER_ID, null);
    session.setAgents(
      FAMILY_DRAG_SERVER_ID,
      new Map([
        ["parent", familyDragAgent("parent", null)],
        ["a", familyDragAgent("a", "parent")],
        ["b", familyDragAgent("b", "parent")],
      ]),
    );
    session.setHasHydratedAgents(FAMILY_DRAG_SERVER_ID, true);
    probe = { guard: null, authority: null, renders: 0 };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root.render(<WorkspaceFamilyDragProbe probe={probe} serverIds={FAMILY_DRAG_SERVER_IDS} />),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useSessionStore.getState().clearSession(FAMILY_DRAG_SERVER_ID);
    useSidebarViewStore.setState(previousView);
    useSidebarCollapsedSectionsStore.setState(previousCollapse);
    useSidebarOrderStore.setState(previousOrder);
    vi.unstubAllGlobals();
  });

  /** Capture the same production guard callback a pending native or web drop already holds. */
  function beginQueuedDrop(): () => void {
    const guard = probe.guard;
    if (guard === null) throw new Error("Family drag probe did not mount");
    guard.onDragBegin();
    return () => dropWithGuard(guard);
  }

  function dropWithGuard(guard: ReturnType<typeof useWorkspaceFamilyDrag>) {
    if (guard.canCommit())
      useSidebarOrderStore.getState().setWorkspaceOrder(FAMILY_DRAG_SCOPE, FAMILY_DRAG_REORDERED);
  }

  function currentAuthority(): WorkspaceFamilyDragAuthority {
    if (probe.authority === null) throw new Error("Family drag authority did not mount");
    return probe.authority;
  }

  function changeParent(parentAgentId: string) {
    useSessionStore.getState().setAgents(FAMILY_DRAG_SERVER_ID, (agents) => {
      const next = new Map(agents);
      next.set("a", familyDragAgent("a", parentAgentId));
      return next;
    });
  }

  it("rejects an old child drop after parentage changes before another projection render", () => {
    const queuedDrop = beginQueuedDrop();
    const rendered = probe.renders;
    const order = useSidebarOrderStore.getState().workspaceOrderByProject;
    act(() => {
      changeParent("other-parent");
      expect(probe.renders).toBe(rendered);
      queuedDrop();
      expect(useSidebarOrderStore.getState().workspaceOrderByProject).toBe(order);
    });
  });

  it("refuses to start from an old projection after an authoritative update", () => {
    const rendered = probe.renders;
    const order = useSidebarOrderStore.getState().workspaceOrderByProject;
    act(() => {
      changeParent("other-parent");
      expect(probe.renders).toBe(rendered);
      const queuedDrop = beginQueuedDrop();
      queuedDrop();
      expect(useSidebarOrderStore.getState().workspaceOrderByProject).toBe(order);
    });
  });

  it("rejects a collapse change before another projection render", () => {
    const queuedDrop = beginQueuedDrop();
    const rendered = probe.renders;
    const order = useSidebarOrderStore.getState().workspaceOrderByProject;
    act(() => {
      useSidebarCollapsedSectionsStore
        .getState()
        .toggleWorkspaceGroupCollapsed("workspace:sidebar-family-drag:parent");
      expect(probe.renders).toBe(rendered);
      queuedDrop();
      expect(useSidebarOrderStore.getState().workspaceOrderByProject).toBe(order);
    });
  });

  it("keeps away-and-back parent changes invalid even when React batches both updates", () => {
    const queuedDrop = beginQueuedDrop();
    const rendered = probe.renders;
    const order = useSidebarOrderStore.getState().workspaceOrderByProject;
    act(() => {
      changeParent("other-parent");
      changeParent("parent");
      expect(probe.renders).toBe(rendered);
      queuedDrop();
      expect(useSidebarOrderStore.getState().workspaceOrderByProject).toBe(order);
    });
  });

  it("keeps away-and-back collapse changes invalid without waiting for a render", () => {
    const queuedDrop = beginQueuedDrop();
    const rendered = probe.renders;
    const order = useSidebarOrderStore.getState().workspaceOrderByProject;
    act(() => {
      const collapse = useSidebarCollapsedSectionsStore.getState();
      collapse.toggleWorkspaceGroupCollapsed("workspace:sidebar-family-drag:parent");
      collapse.toggleWorkspaceGroupCollapsed("workspace:sidebar-family-drag:parent");
      expect(probe.renders).toBe(rendered);
      queuedDrop();
      expect(useSidebarOrderStore.getState().workspaceOrderByProject).toBe(order);
    });
  });

  it("still commits a valid sibling reorder when only unrelated agent activity changes", () => {
    const queuedDrop = beginQueuedDrop();
    act(() => {
      const agents = new Map(useSessionStore.getState().sessions[FAMILY_DRAG_SERVER_ID].agents);
      agents.set("a", { ...familyDragAgent("a", "parent"), lastActivityAt: new Date(1) });
      useSessionStore.getState().setAgents(FAMILY_DRAG_SERVER_ID, agents);
      queuedDrop();
    });
    expect(useSidebarOrderStore.getState().getWorkspaceOrder(FAMILY_DRAG_SCOPE)).toEqual(
      FAMILY_DRAG_REORDERED,
    );
  });

  it("rejects a pending admission after authority replacement at the same generation, then admits a new drag", () => {
    const oldQueuedDrop = beginQueuedDrop();
    const admittedAuthority = currentAuthority();
    const admittedGeneration = admittedAuthority.renderedGeneration;
    const order = useSidebarOrderStore.getState().workspaceOrderByProject;
    act(() => {
      const collapse = useSidebarCollapsedSectionsStore.getState();
      collapse.toggleWorkspaceGroupCollapsed("workspace:sidebar-family-drag:parent");
      collapse.toggleWorkspaceGroupCollapsed("workspace:sidebar-family-drag:parent");
      useSessionStore.getState().setWorkspaces(
        FAMILY_DRAG_SERVER_ID,
        new Map([
          [
            "a",
            workspace({
              id: "a",
              projectId: FAMILY_DRAG_SCOPE,
              projectDisplayName: "Family",
              name: "Renamed child",
            }),
          ],
        ]),
      );
      root.render(
        <WorkspaceFamilyDragProbe
          probe={probe}
          serverIds={[FAMILY_DRAG_SERVER_ID, "additional-family-host"]}
        />,
      );
    });
    const replacementAuthority = currentAuthority();
    expect(replacementAuthority.getGeneration).not.toBe(admittedAuthority.getGeneration);
    expect(replacementAuthority.renderedGeneration).toBe(admittedGeneration);
    const currentGuard = probe.guard;
    if (currentGuard === null) throw new Error("Replacement guard did not mount");
    act(() => {
      // Draggable rows can call the latest handler for a gesture admitted by the old authority.
      dropWithGuard(currentGuard);
      oldQueuedDrop();
      expect(useSidebarOrderStore.getState().workspaceOrderByProject).toBe(order);
    });
    const newQueuedDrop = beginQueuedDrop();
    act(() => newQueuedDrop());
    expect(useSidebarOrderStore.getState().getWorkspaceOrder(FAMILY_DRAG_SCOPE)).toEqual(
      FAMILY_DRAG_REORDERED,
    );
  });

  it("retains the tracker across equivalent host scopes when a workspace rename recreates the collection", () => {
    const oldQueuedDrop = beginQueuedDrop();
    const admittedAuthority = currentAuthority();
    const order = useSidebarOrderStore.getState().workspaceOrderByProject;
    act(() => {
      const collapse = useSidebarCollapsedSectionsStore.getState();
      collapse.toggleWorkspaceGroupCollapsed("workspace:sidebar-family-drag:parent");
      collapse.toggleWorkspaceGroupCollapsed("workspace:sidebar-family-drag:parent");
      useSessionStore.getState().setWorkspaces(
        FAMILY_DRAG_SERVER_ID,
        new Map([
          [
            "a",
            workspace({
              id: "a",
              projectId: FAMILY_DRAG_SCOPE,
              projectDisplayName: "Family",
              name: "Renamed child",
            }),
          ],
        ]),
      );
      root.render(
        <WorkspaceFamilyDragProbe
          probe={probe}
          serverIds={[FAMILY_DRAG_SERVER_ID, FAMILY_DRAG_SERVER_ID]}
        />,
      );
    });
    expect(currentAuthority().getGeneration).toBe(admittedAuthority.getGeneration);
    const currentGuard = probe.guard;
    if (currentGuard === null) throw new Error("Current guard did not mount");
    act(() => {
      dropWithGuard(currentGuard);
      oldQueuedDrop();
      expect(useSidebarOrderStore.getState().workspaceOrderByProject).toBe(order);
    });
  });
});

const FAMILY_DISCLOSURE_PARENT_KEY = "sidebar-family-drag:parent";
const FAMILY_DISCLOSURE_CHILD_KEY = "sidebar-family-drag:a";
const FAMILY_DISCLOSURE_DRAG = vi.fn();
const FAMILY_DISCLOSURE_REORDER = vi.fn<(rows: SidebarWorkspacePlacement[]) => void>();
const FAMILY_DISCLOSURE_ATTENTION = new Set<string>();

/** Keep structural placement names different from the hydrated names shown by actual rows. */
function familyDisclosureEntries(): ReadonlyMap<string, SidebarWorkspaceEntry> {
  const entries = new Map<string, SidebarWorkspaceEntry>();
  for (const id of ["parent", "a", "b"]) {
    const entry = createSidebarWorkspaceEntry({
      serverId: FAMILY_DRAG_SERVER_ID,
      workspace: workspace({
        id,
        projectId: FAMILY_DRAG_SCOPE,
        projectDisplayName: "Family",
        name: id === "parent" ? "Resolved parent title" : `Resolved child ${id}`,
      }),
    });
    entries.set(entry.workspaceKey, {
      ...entry,
      currentBranch: id === "parent" ? "feature/parent" : null,
    });
  }
  return entries;
}

/** Render through the real disclosure, PressHighlight and RN Web accessibility mapping. */
function FamilyDisclosureFixture({
  entries,
  activeWorkspaceKey = null,
}: {
  entries: ReadonlyMap<string, SidebarWorkspaceEntry>;
  activeWorkspaceKey?: string | null;
}) {
  const savedCollapsedKeys = useSidebarCollapsedSectionsStore(
    (state) => state.collapsedWorkspaceGroupKeys,
  );
  const model = useMemo<SidebarWorkspaceTreeModel>(
    () => ({
      tree: FAMILY_DRAG_TREE,
      revision: "family-disclosure",
      dragAuthority: null,
      collapsedKeys: effectiveWorkspaceCollapse({
        tree: FAMILY_DRAG_TREE,
        collapsedKeys: savedCollapsedKeys,
        activeWorkspaceKey,
      }),
      activeWorkspaceKey,
      entries,
      humanAttentionWorkspaceKeys: FAMILY_DISCLOSURE_ATTENTION,
    }),
    [activeWorkspaceKey, entries, savedCollapsedKeys],
  );
  const itemsByKey = useMemo(() => {
    const placements = new Map<string, SidebarWorkspacePlacement>();
    for (const [key, entry] of entries) {
      placements.set(key, { ...entry, name: `wks_internal_${entry.workspaceId}` });
    }
    return placements;
  }, [entries]);
  const row = useMemo(
    () => ({
      item: itemsByKey.get(FAMILY_DISCLOSURE_PARENT_KEY)!,
      index: 0,
      drag: FAMILY_DISCLOSURE_DRAG,
      isActive: false,
    }),
    [itemsByKey],
  );
  return (
    <SidebarWorkspaceTreeProvider value={model}>
      <WorkspaceTreeBranch
        row={row}
        itemsByKey={itemsByKey}
        renderRow={renderFamilyDisclosureRow}
        onSiblingReorder={FAMILY_DISCLOSURE_REORDER}
      />
    </SidebarWorkspaceTreeProvider>
  );
}

function renderFamilyDisclosureRow(row: DraggableRenderItemInfo<SidebarWorkspacePlacement>) {
  return <FamilyDisclosureRow workspaceKey={row.item.workspaceKey} />;
}

/** Use the same owning primary-label resolver as the production workspace row content. */
function FamilyDisclosureRow({ workspaceKey }: { workspaceKey: string }) {
  const { entries } = useSidebarWorkspaceTree();
  const workspaceTitleSource = useSidebarViewStore((state) => state.workspaceTitleSource);
  const entry = entries.get(workspaceKey)!;
  return (
    <span data-testid={`family-disclosure-row-${workspaceKey}`}>
      {resolveSidebarWorkspacePrimaryLabel({ workspace: entry, workspaceTitleSource })}
    </span>
  );
}

describe("workspace family disclosure controls", () => {
  let root: Root;
  let container: HTMLElement;
  let entries: ReadonlyMap<string, SidebarWorkspaceEntry>;
  let previousView: ReturnType<typeof useSidebarViewStore.getState>;
  let previousCollapse: ReturnType<typeof useSidebarCollapsedSectionsStore.getState>;
  let previousLanguage: string;

  beforeEach(async () => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    previousLanguage = sidebarI18n.language;
    await sidebarI18n.changeLanguage("en");
    previousView = useSidebarViewStore.getState();
    previousCollapse = useSidebarCollapsedSectionsStore.getState();
    useSidebarViewStore.setState({ groupMode: "project", workspaceTitleSource: "title" });
    useSidebarCollapsedSectionsStore.setState({
      collapsedProjectKeys: new Set(),
      collapsedWorkspaceGroupKeys: new Set(),
      collapsedPinned: false,
    });
    entries = familyDisclosureEntries();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    act(() => root.unmount());
    container.remove();
    useSidebarViewStore.setState(previousView);
    useSidebarCollapsedSectionsStore.setState(previousCollapse);
    await sidebarI18n.changeLanguage(previousLanguage);
    vi.unstubAllGlobals();
  });

  function mount(activeWorkspaceKey: string | null = null) {
    act(() =>
      root.render(
        <FamilyDisclosureFixture entries={entries} activeWorkspaceKey={activeWorkspaceKey} />,
      ),
    );
  }

  function toggle(): HTMLButtonElement {
    const control = container.querySelector(
      `[data-testid="sidebar-workspace-children-toggle-${FAMILY_DISCLOSURE_PARENT_KEY}"]`,
    );
    if (!(control instanceof HTMLButtonElement)) {
      throw new Error("Real workspace disclosure button did not render");
    }
    return control;
  }

  function childRow(): Element | null {
    return container.querySelector(
      `[data-testid="family-disclosure-row-${FAMILY_DISCLOSURE_CHILD_KEY}"]`,
    );
  }

  it.each([
    { source: "title", branch: "feature/parent", label: "Resolved parent title" },
    { source: "branch", branch: "feature/parent", label: "feature/parent" },
    { source: "branch", branch: null, label: "Resolved parent title" },
  ] as const)("names the disclosure after the visible row ($source, $branch)", (input) => {
    useSidebarViewStore.setState({ workspaceTitleSource: input.source });
    const next = new Map(entries);
    next.set(FAMILY_DISCLOSURE_PARENT_KEY, {
      ...entries.get(FAMILY_DISCLOSURE_PARENT_KEY)!,
      currentBranch: input.branch,
    });
    entries = next;
    mount();
    expect(toggle().getAttribute("aria-label")).toBe(`Collapse child workspaces of ${input.label}`);
    expect(
      container.querySelector(
        `[data-testid="family-disclosure-row-${FAMILY_DISCLOSURE_PARENT_KEY}"]`,
      )?.textContent,
    ).toBe(input.label);
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
  });

  it("updates the disclosure label after a resolved rename while retaining the same button", () => {
    mount();
    const control = toggle();
    const next = new Map(entries);
    next.set(FAMILY_DISCLOSURE_PARENT_KEY, {
      ...entries.get(FAMILY_DISCLOSURE_PARENT_KEY)!,
      name: "Renamed parent title",
    });
    entries = next;
    mount();
    expect(toggle()).toBe(control);
    expect(toggle().getAttribute("aria-label")).toBe(
      "Collapse child workspaces of Renamed parent title",
    );
  });

  it("collapses and expands children with matching DOM semantics and saved membership", () => {
    mount();
    const control = toggle();
    expect(childRow()).not.toBe(null);
    act(() => control.click());
    expect(toggle()).toBe(control);
    expect(control.getAttribute("aria-expanded")).toBe("false");
    expect(control.getAttribute("aria-label")).toBe(
      "Expand child workspaces of Resolved parent title",
    );
    expect(childRow()).toBe(null);
    expect(useSidebarCollapsedSectionsStore.getState().collapsedWorkspaceGroupKeys).toEqual(
      new Set([workspaceCollapseKey(FAMILY_DISCLOSURE_PARENT_KEY)]),
    );
    act(() => control.click());
    expect(control.getAttribute("aria-expanded")).toBe("true");
    expect(control.getAttribute("aria-label")).toBe(
      "Collapse child workspaces of Resolved parent title",
    );
    expect(childRow()).not.toBe(null);
    expect(useSidebarCollapsedSectionsStore.getState().collapsedWorkspaceGroupKeys).toEqual(
      new Set(),
    );
  });

  it("keeps an active child revealed without rewriting its saved collapsed preference", () => {
    useSidebarCollapsedSectionsStore
      .getState()
      .toggleWorkspaceGroupCollapsed(workspaceCollapseKey(FAMILY_DISCLOSURE_PARENT_KEY));
    const saved = useSidebarCollapsedSectionsStore.getState().collapsedWorkspaceGroupKeys;
    mount(FAMILY_DISCLOSURE_CHILD_KEY);
    expect(toggle().disabled).toBe(true);
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(childRow()).not.toBe(null);
    act(() => toggle().click());
    expect(useSidebarCollapsedSectionsStore.getState().collapsedWorkspaceGroupKeys).toBe(saved);
    mount();
    expect(toggle().disabled).toBe(false);
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(childRow()).toBe(null);
    expect(useSidebarCollapsedSectionsStore.getState().collapsedWorkspaceGroupKeys).toBe(saved);
  });
});

const TRANSITION_OTHER_HOST = "sidebar-transition-other-host";
const TRANSITION_PROJECT = "family-transitions";
const TRANSITION_IDS = ["parent", "a", "b", "other-parent", "other-child", "outside"];
const TRANSITION_NAMES: Record<string, string> = {
  parent: "Parent task",
  a: "Only child match",
  b: "Sibling task",
  "other-parent": "Unrelated parent",
  "other-child": "Unrelated child",
  outside: "Independent task",
};
const TRANSITION_SCOPE = createProjectViewKey({
  kind: "equivalence",
  projectKey: TRANSITION_PROJECT,
});

interface FamilyTransitionProbe {
  model: ReturnType<typeof useSidebarModel> | null;
  tree: ReturnType<typeof useSidebarWorkspaceTree> | null;
  childGuard: ReturnType<typeof useWorkspaceFamilyDrag> | null;
  renders: number;
}

interface ChildWorkspaceAttentionIngress {
  replica: WorkspaceDirectoryReplica;
  serverId: string;
  humanAttentionRequired: WorkspaceDescriptor["humanAttentionRequired"];
}

function transitionKey(id: string, serverId = SERVER_ID): string {
  return `${serverId}:${id}`;
}

/** Lifetime relationships used by both directory seeding and wire-ingestion fixtures. */
function transitionParent(id: string): string | null {
  if (id === "a" || id === "b") return "parent";
  if (id === "other-child") return "other-parent";
  return null;
}

/** Seed authoritative directory records and agent relationships, never a replacement sidebar tree. */
function seedFamilyTransitions(serverId: string): void {
  const store = useSessionStore.getState();
  store.initializeSession(serverId, null);
  const workspaces = new Map<string, WorkspaceDescriptor>();
  const agents = new Map<string, Agent>();
  for (const id of TRANSITION_IDS) {
    workspaces.set(
      id,
      workspace({
        id,
        projectId: TRANSITION_PROJECT,
        projectDisplayName: "Transitions",
        name: TRANSITION_NAMES[id],
      }),
    );
    const parent = transitionParent(id);
    agents.set(id, {
      ...familyDragAgent(id, parent),
      serverId,
      cwd: `/repo/${TRANSITION_PROJECT}/${id}`,
      labels: parent ? parentAddressLabels({ serverId, agentId: parent }) : {},
    });
  }
  seedRuntimeWorkspaces(serverId, workspaces);
  store.setHasHydratedWorkspaces(serverId, true);
  store.setAgents(serverId, agents);
  store.setHasHydratedAgents(serverId, true);
}

/** The production provider supplies filtering, parent proof, pin partitions, shortcuts and attention. */
function FamilyTransitionSurface({ probe }: { probe: FamilyTransitionProbe }) {
  const model = useSidebarModel();
  const tree = useSidebarWorkspaceTree();
  probe.model = model;
  probe.tree = tree;
  probe.renders += 1;
  const pinned = workspaceFamilyRoots(model.pinnedGroups.pinnedChats, tree.tree);
  const ordinary: SidebarWorkspacePlacement[] = [];
  for (const project of model.pinnedGroups.unpinnedProjects) {
    ordinary.push(...workspaceFamilyRoots(project.workspaces, tree.tree));
  }
  const renderRow = React.useCallback(
    (row: DraggableRenderItemInfo<SidebarWorkspacePlacement>) => (
      <FamilyTransitionRow row={row} probe={probe} />
    ),
    [probe],
  );
  return (
    <>
      <div data-testid="transition-pinned-roots">
        {pinned.map((item) => (
          <FamilyTransitionBranch key={item.workspaceKey} item={item} renderRow={renderRow} />
        ))}
      </div>
      <div data-testid="transition-ordinary-roots">
        {ordinary.map((item) => (
          <FamilyTransitionBranch key={item.workspaceKey} item={item} renderRow={renderRow} />
        ))}
      </div>
    </>
  );
}

function FamilyTransitionBranch({
  item,
  renderRow,
}: {
  item: SidebarWorkspacePlacement;
  renderRow: (row: DraggableRenderItemInfo<SidebarWorkspacePlacement>) => ReactElement;
}) {
  const { entries } = useSidebarWorkspaceTree();
  const row = useMemo(
    () => ({ item, index: 0, drag: FAMILY_DISCLOSURE_DRAG, isActive: false }),
    [item],
  );
  return (
    <WorkspaceTreeBranch
      row={row}
      itemsByKey={entries}
      renderRow={renderRow}
      onSiblingReorder={FAMILY_DISCLOSURE_REORDER}
    />
  );
}

/** Capture the real child-row admission; a retained callback can run before the provider re-renders. */
function FamilyTransitionRow({
  row,
  probe,
}: {
  row: DraggableRenderItemInfo<SidebarWorkspacePlacement>;
  probe: FamilyTransitionProbe;
}) {
  const guard = useWorkspaceFamilyDrag();
  if (row.item.workspaceKey === transitionKey("a")) probe.childGuard = guard;
  return <FamilyDisclosureRow workspaceKey={row.item.workspaceKey} />;
}

/** Decode actual app wire fields before the replica normalizes and publishes them to the store. */
function transitionWireSnapshot(input: {
  serverId: string;
  id: string;
  permission?: boolean;
  humanAttentionRequired?: boolean;
  revision?: number;
}): AgentSnapshotPayload {
  const parent = transitionParent(input.id);
  const agent: Agent = {
    ...familyDragAgent(input.id, parent),
    serverId: input.serverId,
    cwd: `/repo/${TRANSITION_PROJECT}/${input.id}`,
    labels: parent ? parentAddressLabels({ serverId: input.serverId, agentId: parent }) : {},
  };
  const wire = {
    ...projectAgentSnapshot(agent),
    updatedAt: new Date(input.revision ?? 0).toISOString(),
    requiresAttention: input.permission === true,
    attentionReason: input.permission ? "permission" : null,
    humanAttentionRequired: input.humanAttentionRequired ?? false,
    attentionMessage: input.humanAttentionRequired ? "Choose an account" : null,
    pendingPermissions: input.permission
      ? [{ id: "permission", provider: "codex", name: "shell", kind: "tool" }]
      : [],
  };
  return AgentSnapshotPayloadSchema.parse(JSON.parse(JSON.stringify(wire)));
}

describe("workspace family store transitions", () => {
  let root: Root;
  let container: HTMLElement;
  let client: QueryClient;
  let probe: FamilyTransitionProbe;
  let previousView: ReturnType<typeof useSidebarViewStore.getState>;
  let previousCollapse: ReturnType<typeof useSidebarCollapsedSectionsStore.getState>;
  let previousOrder: ReturnType<typeof useSidebarOrderStore.getState>;
  let previousFilter: ReturnType<typeof useSidebarQuickFilterStore.getState>;
  let previousPath: string;
  let previousLanguage: string;

  beforeEach(async () => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    previousLanguage = sidebarI18n.language;
    await sidebarI18n.changeLanguage("en");
    previousView = useSidebarViewStore.getState();
    previousCollapse = useSidebarCollapsedSectionsStore.getState();
    previousOrder = useSidebarOrderStore.getState();
    previousFilter = useSidebarQuickFilterStore.getState();
    previousPath = pathnameState.value;
    pathnameState.value = "/open-project";
    setHostProfiles([
      makeHost(),
      { ...makeHost(), serverId: TRANSITION_OTHER_HOST, label: "Other host" },
    ]);
    seedFamilyTransitions(SERVER_ID);
    seedFamilyTransitions(TRANSITION_OTHER_HOST);
    useSidebarViewStore.setState({
      groupMode: "project",
      sortMode: "custom",
      workspaceSortMode: "custom",
      workspaceTitleSource: "title",
      hostFilters: [SERVER_ID],
      projectFilters: [],
      labelFilter: { labels: [] },
      projectVisibility: "all",
      showBackground: true,
    });
    useSidebarCollapsedSectionsStore.setState({
      collapsedProjectKeys: new Set(),
      collapsedWorkspaceGroupKeys: new Set(),
      collapsedPinned: false,
    });
    useSidebarQuickFilterStore.setState({
      byMode: { project: { open: false, text: "" }, status: { open: false, text: "" } },
    });
    useSidebarOrderStore.setState({
      projectOrder: [TRANSITION_SCOPE],
      workspaceOrderByProject: {
        [TRANSITION_SCOPE]: TRANSITION_IDS.map((id) => transitionKey(id)),
      },
      statusWorkspaceOrder: [],
      pinnedWorkspaceOrder: [],
    });
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(APP_SETTINGS_QUERY_KEY, DEFAULT_CLIENT_SETTINGS);
    probe = { model: null, tree: null, childGuard: null, renders: 0 };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    act(() => root.unmount());
    container.remove();
    client.clear();
    setHostProfiles([]);
    useSessionStore.getState().clearSession(SERVER_ID);
    useSessionStore.getState().clearSession(TRANSITION_OTHER_HOST);
    useSidebarViewStore.setState(previousView);
    useSidebarCollapsedSectionsStore.setState(previousCollapse);
    useSidebarOrderStore.setState(previousOrder);
    useSidebarQuickFilterStore.setState(previousFilter);
    pathnameState.value = previousPath;
    vi.restoreAllMocks();
    await sidebarI18n.changeLanguage(previousLanguage);
    vi.unstubAllGlobals();
  });

  function render() {
    root.render(
      <QueryClientProvider client={client}>
        <SidebarModelProvider active>
          <FamilyTransitionSurface probe={probe} />
        </SidebarModelProvider>
      </QueryClientProvider>,
    );
  }

  function currentModel() {
    if (probe.model === null) throw new Error("Production sidebar model did not mount");
    return probe.model;
  }

  function currentTree() {
    if (probe.tree === null) throw new Error("Production sidebar tree did not mount");
    return probe.tree;
  }

  /** DOM traversal and production shortcut traversal must expose the same once-only rows. */
  function expectVisible(ids: string[]) {
    const rendered = Array.from(
      container.querySelectorAll('[data-testid^="family-disclosure-row-"]'),
      (row) => row.getAttribute("data-testid")?.replace("family-disclosure-row-", ""),
    );
    expect(rendered).toEqual(ids.map((id) => transitionKey(id)));
    const shortcuts = currentModel().shortcutModel.shortcutTargets.map((target) =>
      transitionKey(target.workspaceId, target.serverId),
    );
    expect(shortcuts).toEqual(rendered);
    expect(new Set(rendered).size).toBe(rendered.length);
  }

  function collapse(id: string, serverId = SERVER_ID) {
    useSidebarCollapsedSectionsStore
      .getState()
      .toggleWorkspaceGroupCollapsed(workspaceCollapseKey(transitionKey(id, serverId)));
  }

  function expectUnrelatedFamily() {
    expect(currentTree().tree.get(transitionKey("other-child"))?.parentKey).toBe(
      transitionKey("other-parent"),
    );
    expect(
      container.querySelector(
        `[data-testid="family-disclosure-row-${transitionKey("other-child")}"]`,
      ),
    ).toBe(null);
  }

  /** Keep the production guard and project reorder policy; only the final persistence adapter is a test callback. */
  function beginSiblingDrop(): () => void {
    const guard = probe.childGuard;
    if (guard === null) throw new Error("Real child guard did not mount");
    const project = currentModel().pinnedGroups.unpinnedProjects.find(
      (item) => item.viewKey === TRANSITION_SCOPE,
    );
    if (!project) throw new Error("Authoritative project scope missing");
    const visibleKeys = project.workspaces.map((item) => item.workspaceKey);
    guard.onDragBegin();
    return () => {
      if (!guard.canCommit()) return;
      const order = useSidebarOrderStore.getState();
      const result = resolveProjectWorkspaceReorder({
        currentVisibleKeys: visibleKeys,
        reorderedVisibleKeys: [transitionKey("b"), transitionKey("a")],
        projectPinnedKeys: new Set(),
        storedWorkspaceOrder: order.getWorkspaceOrder(TRANSITION_SCOPE),
      });
      if (result.workspaceOrder !== null)
        order.setWorkspaceOrder(TRANSITION_SCOPE, result.workspaceOrder);
    };
  }

  function setPinned(pinned: boolean) {
    const store = useSessionStore.getState();
    const workspaces = new Map(store.sessions[SERVER_ID].workspaces);
    const child = workspaces.get("a");
    if (!child) throw new Error("Dragged workspace missing");
    workspaces.set("a", { ...child, pinnedAt: pinned ? "2026-10-22T12:00:00.000Z" : null });
    store.setWorkspaces(SERVER_ID, workspaces);
  }

  /** Exercise the app's actual snapshot replica; server-side serialization is outside this suite. */
  function ingest(
    replica: AgentDirectoryReplica,
    serverId: string,
    human: boolean,
    revision: number,
  ) {
    const snapshots: Parameters<AgentDirectoryReplica["commitSnapshot"]>[0] = [];
    for (const id of TRANSITION_IDS) {
      snapshots.push({
        agent: transitionWireSnapshot({
          serverId,
          id,
          permission: id === "a",
          humanAttentionRequired: id === "a" && human,
          revision,
        }),
        project: {
          projectKey: TRANSITION_PROJECT,
          projectName: "Transitions",
          checkout: {
            cwd: `/repo/${TRANSITION_PROJECT}/${id}`,
            isGit: true,
            currentBranch: null,
            remoteUrl: null,
            worktreeRoot: `/repo/${TRANSITION_PROJECT}/${id}`,
            isPaseoOwnedWorktree: false,
            mainRepoRoot: null,
          },
        },
      });
    }
    replica.commitSnapshot(snapshots, []);
  }

  function summary(serverId: string): string | null | undefined {
    return container.querySelector(
      `[data-testid="sidebar-workspace-children-summary-${transitionKey("parent", serverId)}"]`,
    )?.textContent;
  }

  /** Publish real workspace wire metadata while the agent snapshot and raw blocker remain fixed. */
  function ingestChildWorkspaceAttention(input: ChildWorkspaceAttentionIngress): void {
    const child = useSessionStore.getState().sessions[input.serverId].workspaces.get("a");
    if (!child) throw new Error("Authoritative child workspace missing");
    const wire = JSON.parse(
      JSON.stringify({
        ...child,
        activityAt: null,
        humanAttentionRequired: input.humanAttentionRequired,
      }),
    );
    const payload = WorkspaceDescriptorPayloadSchema.parse(wire);
    input.replica.applyDelta({ kind: "upsert", workspace: payload });
  }

  function expectBlocker(serverId: string) {
    expect(
      currentModel().workspaceEntriesByKey.get(transitionKey("a", serverId))?.statusBucket,
    ).toBe("needs_input");
    expect(
      currentModel().workspaceEntriesByKey.get(transitionKey("parent", serverId))?.statusBucket,
    ).toBe("done");
    expect(
      container.querySelector(
        `[data-testid="family-disclosure-row-${transitionKey("a", serverId)}"]`,
      ),
    ).toBe(null);
    expect(useSessionStore.getState().sessions[serverId].agents.get("a")).toMatchObject({
      pendingPermissions: [{ id: "permission" }],
      requiresAttention: true,
    });
  }

  it("T53 relationship removal transition preserves collapse and unrelated children", () => {
    collapse("parent");
    collapse("other-parent");
    const saved = useSidebarCollapsedSectionsStore.getState().collapsedWorkspaceGroupKeys;
    const original = useSessionStore.getState().sessions[SERVER_ID].agents;
    const parent = original.get("parent");
    if (!parent) throw new Error("Authoritative parent agent missing");
    act(render);
    expectVisible(["parent", "other-parent", "outside"]);
    const removed = new Map(original);
    removed.delete("parent");
    act(() => useSessionStore.getState().setAgents(SERVER_ID, removed));
    expect(currentTree().tree.get(transitionKey("a"))?.parentKey).toBe(null);
    expectVisible(["parent", "a", "b", "other-parent", "outside"]);
    expectUnrelatedFamily();
    expect(useSidebarCollapsedSectionsStore.getState().collapsedWorkspaceGroupKeys).toBe(saved);
    act(() => useSessionStore.getState().setAgents(SERVER_ID, original));
    expectVisible(["parent", "other-parent", "outside"]);
    const archived = new Map(original);
    archived.set("parent", { ...parent, archivedAt: new Date("2026-10-22T12:00:00.000Z") });
    act(() => useSessionStore.getState().setAgents(SERVER_ID, archived));
    expectVisible(["parent", "a", "b", "other-parent", "outside"]);
    expectUnrelatedFamily();
    act(() => useSessionStore.getState().setAgents(SERVER_ID, original));
    expectVisible(["parent", "other-parent", "outside"]);
    expect(currentTree().tree.get(transitionKey("a"))?.parentKey).toBe(transitionKey("parent"));
    expect(useSidebarCollapsedSectionsStore.getState().collapsedWorkspaceGroupKeys).toBe(saved);
  });

  it("T53 pin transition rejects a retained sibling drop and admits a fresh unpinned drag", () => {
    act(render);
    const drop = beginSiblingDrop();
    const renders = probe.renders;
    const order = useSidebarOrderStore.getState();
    const before = order.workspaceOrderByProject;
    const writes = vi.spyOn(order, "setWorkspaceOrder");
    act(() => {
      setPinned(true);
      expect(probe.renders).toBe(renders);
      drop();
      expect(writes).not.toHaveBeenCalled();
      expect(useSidebarOrderStore.getState().workspaceOrderByProject).toBe(before);
    });
    expect(currentModel().pinnedGroups.pinnedChats.map((row) => row.workspaceKey)).toEqual([
      transitionKey("a"),
    ]);
    expectVisible(["a", "parent", "b", "other-parent", "other-child", "outside"]);
    act(() => setPinned(false));
    expect(currentModel().pinnedGroups.pinnedChats).toEqual([]);
    expectVisible(TRANSITION_IDS);
    const freshDrop = beginSiblingDrop();
    act(freshDrop);
    expect(writes).toHaveBeenCalledExactlyOnceWith(
      TRANSITION_SCOPE,
      ["b", "a", "parent", "other-parent", "other-child", "outside"].map((id) => transitionKey(id)),
    );
    expectVisible(["parent", "b", "a", "other-parent", "other-child", "outside"]);
  });

  it("T53 filter navigation transition reveals an active child then restores saved collapse", () => {
    collapse("parent");
    const saved = useSidebarCollapsedSectionsStore.getState().collapsedWorkspaceGroupKeys;
    const filter = useSidebarQuickFilterStore.getState();
    filter.toggle("project");
    filter.setText("project", "Only child match");
    act(render);
    expectVisible(["a"]);
    expect(currentTree().tree.get(transitionKey("a"))?.parentKey).toBe(null);
    act(() => {
      // Only the existing Expo route adapter is faked; navigation and active-selection stores are real.
      pathnameState.value = navigateToWorkspace({ serverId: SERVER_ID, workspaceId: "a" });
      render();
    });
    expect(getLastWorkspaceSelection()).toEqual({ serverId: SERVER_ID, workspaceId: "a" });
    expectVisible(["a"]);
    act(() => filter.close("project"));
    expect(currentTree().tree.get(transitionKey("a"))?.parentKey).toBe(transitionKey("parent"));
    expectVisible(TRANSITION_IDS);
    expect(useSidebarCollapsedSectionsStore.getState().collapsedWorkspaceGroupKeys).toBe(saved);
    act(() => {
      pathnameState.value = navigateToWorkspace({ serverId: SERVER_ID, workspaceId: "outside" });
      render();
    });
    expect(getLastWorkspaceSelection()).toEqual({ serverId: SERVER_ID, workspaceId: "outside" });
    expectVisible(["parent", "other-parent", "other-child", "outside"]);
    expect(useSidebarCollapsedSectionsStore.getState().collapsedWorkspaceGroupKeys).toBe(saved);
  });

  it("T53 workspace ingress changes collapsed attention without changing agents", () => {
    useSidebarViewStore.setState({ hostFilters: [] });
    collapse("parent");
    collapse("parent", TRANSITION_OTHER_HOST);
    const firstAgents = new AgentDirectoryReplica(SERVER_ID, vi.fn(), vi.fn());
    const secondAgents = new AgentDirectoryReplica(TRANSITION_OTHER_HOST, vi.fn(), vi.fn());
    ingest(firstAgents, SERVER_ID, false, 1);
    ingest(secondAgents, TRANSITION_OTHER_HOST, false, 1);
    const first = new WorkspaceDirectoryReplica(SERVER_ID);
    const second = new WorkspaceDirectoryReplica(TRANSITION_OTHER_HOST);
    const sessions = useSessionStore.getState().sessions;
    first.commitCached({
      workspaces: sessions[SERVER_ID].workspaces,
      projects: sessions[SERVER_ID].projects,
    });
    second.commitCached({
      workspaces: sessions[TRANSITION_OTHER_HOST].workspaces,
      projects: sessions[TRANSITION_OTHER_HOST].projects,
    });
    const agents = sessions[SERVER_ID].agents;
    const foreignAgents = sessions[TRANSITION_OTHER_HOST].agents;
    const saved = useSidebarCollapsedSectionsStore.getState().collapsedWorkspaceGroupKeys;
    ingestChildWorkspaceAttention({
      replica: first,
      serverId: SERVER_ID,
      humanAttentionRequired: false,
    });
    ingestChildWorkspaceAttention({
      replica: second,
      serverId: TRANSITION_OTHER_HOST,
      humanAttentionRequired: false,
    });
    act(render);
    expectBlocker(SERVER_ID);
    expectBlocker(TRANSITION_OTHER_HOST);
    expect(currentTree().humanAttentionWorkspaceKeys).toEqual(new Set());
    expect(summary(SERVER_ID)).toBe("2 child workspaces: Needs input");
    expect(summary(TRANSITION_OTHER_HOST)).toBe("2 child workspaces: Needs input");

    act(() =>
      ingestChildWorkspaceAttention({
        replica: first,
        serverId: SERVER_ID,
        humanAttentionRequired: true,
      }),
    );
    const activeKeys = currentTree().humanAttentionWorkspaceKeys;
    expect(activeKeys).toEqual(new Set([transitionKey("a")]));
    expect(summary(SERVER_ID)).toBe(
      "2 child workspaces: Needs input1 child workspace needs your attention",
    );
    expect(summary(TRANSITION_OTHER_HOST)).toBe("2 child workspaces: Needs input");
    expectBlocker(SERVER_ID);
    act(() =>
      ingestChildWorkspaceAttention({
        replica: first,
        serverId: SERVER_ID,
        humanAttentionRequired: true,
      }),
    );
    expect(currentTree().humanAttentionWorkspaceKeys).toBe(activeKeys);

    act(() =>
      ingestChildWorkspaceAttention({
        replica: first,
        serverId: SERVER_ID,
        humanAttentionRequired: false,
      }),
    );
    expect(currentTree().humanAttentionWorkspaceKeys).toEqual(new Set());
    expect(summary(SERVER_ID)).toBe("2 child workspaces: Needs input");
    act(() =>
      ingestChildWorkspaceAttention({
        replica: second,
        serverId: TRANSITION_OTHER_HOST,
        humanAttentionRequired: true,
      }),
    );
    expect(currentTree().humanAttentionWorkspaceKeys).toEqual(
      new Set([transitionKey("a", TRANSITION_OTHER_HOST)]),
    );
    expect(summary(SERVER_ID)).toBe("2 child workspaces: Needs input");
    expect(summary(TRANSITION_OTHER_HOST)).toBe(
      "2 child workspaces: Needs input1 child workspace needs your attention",
    );

    const filter = useSidebarQuickFilterStore.getState();
    act(() => {
      filter.toggle("project");
      filter.setText("project", "Sibling task");
    });
    expect(currentTree().humanAttentionWorkspaceKeys).toEqual(new Set());
    expect(summary(SERVER_ID)).toBeUndefined();
    expect(summary(TRANSITION_OTHER_HOST)).toBeUndefined();
    act(() => filter.close("project"));
    expect(currentTree().humanAttentionWorkspaceKeys).toEqual(
      new Set([transitionKey("a", TRANSITION_OTHER_HOST)]),
    );
    expect(summary(TRANSITION_OTHER_HOST)).toBe(
      "2 child workspaces: Needs input1 child workspace needs your attention",
    );
    act(() =>
      ingestChildWorkspaceAttention({
        replica: second,
        serverId: TRANSITION_OTHER_HOST,
        humanAttentionRequired: undefined,
      }),
    );
    expect(currentTree().humanAttentionWorkspaceKeys).toEqual(new Set());
    expect(summary(TRANSITION_OTHER_HOST)).toBe("2 child workspaces: Needs input");
    expectBlocker(SERVER_ID);
    expectBlocker(TRANSITION_OTHER_HOST);
    expect(useSessionStore.getState().sessions[SERVER_ID].agents).toBe(agents);
    expect(useSessionStore.getState().sessions[TRANSITION_OTHER_HOST].agents).toBe(foreignAgents);
    expect(useSidebarCollapsedSectionsStore.getState().collapsedWorkspaceGroupKeys).toBe(saved);
  });

  it("T53 wire attention transition keeps hidden blockers distinct and hosts isolated", () => {
    useSidebarViewStore.setState({ hostFilters: [] });
    collapse("parent");
    collapse("parent", TRANSITION_OTHER_HOST);
    const first = new AgentDirectoryReplica(SERVER_ID, vi.fn(), vi.fn());
    const second = new AgentDirectoryReplica(TRANSITION_OTHER_HOST, vi.fn(), vi.fn());
    ingest(first, SERVER_ID, false, 1);
    ingest(second, TRANSITION_OTHER_HOST, false, 1);
    act(render);
    expectBlocker(SERVER_ID);
    expectBlocker(TRANSITION_OTHER_HOST);
    expect(currentTree().humanAttentionWorkspaceKeys).toEqual(new Set());
    expect(summary(SERVER_ID)).toBe("2 child workspaces: Needs input");
    expect(summary(TRANSITION_OTHER_HOST)).toBe("2 child workspaces: Needs input");
    act(() => ingest(first, SERVER_ID, true, 2));
    expect(currentTree().humanAttentionWorkspaceKeys).toEqual(new Set([transitionKey("a")]));
    expect(summary(SERVER_ID)).toBe(
      "2 child workspaces: Needs input1 child workspace needs your attention",
    );
    expect(summary(TRANSITION_OTHER_HOST)).toBe("2 child workspaces: Needs input");
    act(() => ingest(first, SERVER_ID, false, 3));
    expectBlocker(SERVER_ID);
    expect(currentTree().humanAttentionWorkspaceKeys).toEqual(new Set());
    expect(summary(SERVER_ID)).toBe("2 child workspaces: Needs input");
    act(() => ingest(second, TRANSITION_OTHER_HOST, true, 4));
    expect(currentTree().humanAttentionWorkspaceKeys).toEqual(
      new Set([transitionKey("a", TRANSITION_OTHER_HOST)]),
    );
    expect(summary(SERVER_ID)).toBe("2 child workspaces: Needs input");
    expect(summary(TRANSITION_OTHER_HOST)).toBe(
      "2 child workspaces: Needs input1 child workspace needs your attention",
    );
    act(() => ingest(second, TRANSITION_OTHER_HOST, false, 5));
    expectBlocker(TRANSITION_OTHER_HOST);
    expect(currentTree().humanAttentionWorkspaceKeys).toEqual(new Set());
    expect(summary(TRANSITION_OTHER_HOST)).toBe("2 child workspaces: Needs input");
  });
});
