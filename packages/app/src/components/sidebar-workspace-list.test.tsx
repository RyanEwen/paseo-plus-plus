/**
 * @vitest-environment jsdom
 */
import { act } from "@testing-library/react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { WorkspaceScriptPayload } from "@getpaseo/protocol/messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React from "react";
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
} from "@/hooks/use-sidebar-workspaces-list";
import { useSidebarWorkspacesList } from "@/hooks/use-sidebar-workspaces-list";
import {
  getHostRuntimeStore,
  type HostRuntimeController,
  type HostRuntimeSnapshot,
} from "@/runtime/host-runtime";
import type { HostProfile } from "@/types/host-connection";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import { seedRuntimeWorkspaces } from "@/test/seed-session";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import { useWorkspaceFields } from "@/stores/session-store-hooks";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { defaultHostAppearance } from "@/hosts/appearance";

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
