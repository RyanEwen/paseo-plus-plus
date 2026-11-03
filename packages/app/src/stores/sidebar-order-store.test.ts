import { moveProjectInFullOrder } from "@/utils/sidebar-reorder";
import { beforeEach, describe, expect, it } from "vitest";
import {
  computeSidebarOrderUpdates,
  type SidebarProjectEntry,
} from "@/hooks/sidebar-workspaces-view-model";
import { migrateSidebarOrderState, useSidebarOrderStore } from "./sidebar-order-store";

describe("migrateSidebarOrderState", () => {
  it("preserves legacy workspace ordering across hosts", () => {
    const migrated = migrateSidebarOrderState({
      projectOrderByServerId: {
        "host-a": ["project-a"],
        "host-b": ["project-a"],
      },
      workspaceOrderByServerAndProject: {
        "host-a::project-a": ["main", "feature"],
        "host-b::project-a": ["main"],
      },
    });

    expect(migrated).toEqual({
      statusWorkspaceOrder: [],
      projectOrder: ["project-a"],
      pinnedWorkspaceOrder: [],
      workspaceOrderByProject: { "project-a": ["host-a:main", "host-a:feature", "host-b:main"] },
    });
  });

  it("preserves and normalizes status-group custom order during migration", () => {
    expect(
      migrateSidebarOrderState({ statusWorkspaceOrder: [" srv:one ", "srv:one", "", "srv:two"] })
        .statusWorkspaceOrder,
    ).toEqual(["srv:one", "srv:two"]);
    const store = useSidebarOrderStore.getState();
    store.setStatusWorkspaceOrder(["srv:two", "srv:two", "", "srv:one"]);
    expect(useSidebarOrderStore.getState().statusWorkspaceOrder).toEqual(["srv:two", "srv:one"]);
  });

  describe("normalizes pinned workspace order", () => {
    it("deduplicates pinned workspace order without rewriting identities", () => {
      const migrated = migrateSidebarOrderState({
        pinnedWorkspaceOrder: ["host-a:one", "host-a:one", "", "host-b:two"],
      });

      expect(migrated.pinnedWorkspaceOrder).toEqual(["host-a:one", "host-b:two"]);
    });
  });

  // A directory whose name ends in a space produces a view key that ends in a
  // space. Trimming it on write used to make the sidebar's reconcile effect loop
  // forever, crashing the app with React error #185 (see #4880).
  describe("sidebar order keys that end in whitespace", () => {
    const PROJECT_KEY = "host:srv-1:/home/u/Reklamation ";

    beforeEach(() => {
      useSidebarOrderStore.setState({
        projectOrder: [],
        pinnedWorkspaceOrder: [],
      });
    });

    it("stores a project key exactly as given", () => {
      useSidebarOrderStore.getState().setProjectOrder([PROJECT_KEY]);

      expect(useSidebarOrderStore.getState().projectOrder).toEqual([PROJECT_KEY]);
    });

    it("settles the sidebar order reconcile instead of rewriting it forever", () => {
      const projects: SidebarProjectEntry[] = [
        {
          viewKey: PROJECT_KEY,
          projectName: "Reklamation ",
          projectKind: "non_git",
          iconWorkingDir: "/home/u/Reklamation ",
          hosts: [],
          workspaces: [],
        },
      ];
      const runPass = () =>
        computeSidebarOrderUpdates({
          projects,
          persistedProjectOrder: useSidebarOrderStore.getState().projectOrder,
        });

      // First pass adds the newly visible project.
      const first = runPass();
      expect(first.projectOrder).toEqual([PROJECT_KEY]);
      useSidebarOrderStore.getState().setProjectOrder(first.projectOrder ?? []);

      // Second pass must find nothing left to do; otherwise the effect that
      // applies these updates re-runs on every render.
      expect(runPass().projectOrder).toBeNull();
    });

    it("still trims legacy keys when migrating per-host persisted state", () => {
      const migrated = migrateSidebarOrderState({
        projectOrderByServerId: { host: [" host-a:one ", "host-a:one"] },
      });

      expect(migrated.projectOrder).toEqual(["host-a:one"]);
    });
  });

  it("keeps the filtered anchor move when later reconciliation appends a new cached project", () => {
    const order = useSidebarOrderStore.getState();
    order.setProjectOrder(["a", "hidden", "b", "unknown"]);
    const next = moveProjectInFullOrder({
      currentOrder: order.getProjectOrder(),
      knownProjectKeys: ["a", "hidden", "b"],
      move: { activeKey: "b", overKey: "a", from: 1, to: 0 },
    });
    order.setProjectOrder(next!);
    const projects: SidebarProjectEntry[] = ["a", "hidden", "b", "new"].map((viewKey) => ({
      viewKey,
      projectName: viewKey,
      projectKind: "non_git",
      iconWorkingDir: `/repo/${viewKey}`,
      hosts: [],
      workspaces: [],
    }));
    const updates = computeSidebarOrderUpdates({
      projects,
      persistedProjectOrder: order.getProjectOrder(),
      getWorkspaceOrder: order.getWorkspaceOrder,
    });
    order.setProjectOrder(updates.projectOrder!);
    expect(order.getProjectOrder()).toEqual(["b", "a", "hidden", "unknown", "new"]);
    expect(
      computeSidebarOrderUpdates({
        projects,
        persistedProjectOrder: order.getProjectOrder(),
        getWorkspaceOrder: order.getWorkspaceOrder,
      }).projectOrder,
    ).toBeNull();
  });
});

it("preserves project, pinned and ordinary workspace order", () => {
  expect(
    migrateSidebarOrderState({
      projectOrder: ["b", "a"],
      pinnedWorkspaceOrder: ["h:y", "h:x"],
      workspaceOrderByProject: { a: ["h:old", "h:new"] },
    }),
  ).toEqual({
    statusWorkspaceOrder: [],
    projectOrder: ["b", "a"],
    pinnedWorkspaceOrder: ["h:y", "h:x"],
    workspaceOrderByProject: { a: ["h:old", "h:new"] },
  });
});

it("preserves whitespace in current project and pin identities during upgrade", () => {
  expect(
    migrateSidebarOrderState({
      projectOrder: ["project "],
      pinnedWorkspaceOrder: ["host:workspace "],
      workspaceOrderByProject: {},
    }),
  ).toEqual({
    statusWorkspaceOrder: [],
    projectOrder: ["project "],
    pinnedWorkspaceOrder: ["host:workspace "],
    workspaceOrderByProject: {},
  });
});

it("retains a pre-beta manual order when upgrading", () => {
  expect(
    migrateSidebarOrderState({
      projectOrder: ["project"],
      pinnedWorkspaceOrder: [],
      workspaceOrderByProject: { project: ["host:b", "host:a"] },
    }),
  ).toEqual({
    statusWorkspaceOrder: [],
    projectOrder: ["project"],
    pinnedWorkspaceOrder: [],
    workspaceOrderByProject: { project: ["host:b", "host:a"] },
  });
});

it("starts with an empty manual order for beta users whose order was discarded", () => {
  expect(migrateSidebarOrderState({ projectOrder: ["p"], pinnedWorkspaceOrder: ["h:a"] })).toEqual({
    statusWorkspaceOrder: [],
    projectOrder: ["p"],
    pinnedWorkspaceOrder: ["h:a"],
    workspaceOrderByProject: {},
  });
});
it("preserves spaces in saved workspace scopes and identities", () => {
  expect(
    migrateSidebarOrderState({ workspaceOrderByProject: { "project ": ["host:b ", "host:a "] } })
      .workspaceOrderByProject,
  ).toEqual({ "project ": ["host:b ", "host:a "] });
});
