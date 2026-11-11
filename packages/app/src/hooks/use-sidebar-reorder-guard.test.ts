import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useSidebarQuickFilterStore } from "@/stores/sidebar-quick-filter-store";
import { subscribeSidebarPreferenceEdits, useSidebarViewStore } from "@/stores/sidebar-view-store";
import { sidebarReorderContext } from "@/utils/sidebar-reorder";
import { createSidebarReorderGuard, type SidebarReorderGuard } from "./use-sidebar-reorder-guard";

/** The context the sidebar would render now, as the hook passes it to begin(). */
function renderedContext(domain: "project" | "workspace"): string {
  const view = useSidebarViewStore.getState();
  const text = useSidebarQuickFilterStore.getState().byMode[view.groupMode].text;
  return sidebarReorderContext(view, domain, text);
}

/** Wire a guard to both stores the way useSidebarReorderGuard does. */
function observedGuard(domain: "project" | "workspace") {
  const guard: SidebarReorderGuard = createSidebarReorderGuard(domain);
  const stopView = useSidebarViewStore.subscribe(guard.invalidate);
  const stopText = useSidebarQuickFilterStore.subscribe(guard.invalidate);
  return {
    guard,
    stop: () => {
      stopView();
      stopText();
    },
  };
}

describe("sidebar reorder guard", () => {
  let stop: () => void = () => {};
  beforeEach(() => {
    useSidebarQuickFilterStore.getState().close("project");
    useSidebarQuickFilterStore.getState().close("status");
    useSidebarViewStore.setState({ groupMode: "project", workspaceSortMode: "custom" });
  });
  afterEach(() => stop());

  it("rejects a drop when its sorting changes away and back without issuing preference commands", () => {
    const edits: unknown[] = [];
    const stopEdits = subscribeSidebarPreferenceEdits((next) => edits.push(next));
    const observed = observedGuard("workspace");
    stop = () => {
      observed.stop();
      stopEdits();
    };
    observed.guard.begin(renderedContext("workspace"));
    expect(observed.guard.canCommit()).toBe(true);
    useSidebarViewStore.setState({ workspaceSortMode: "name" });
    expect(observed.guard.canCommit()).toBe(false);
    useSidebarViewStore.setState({ workspaceSortMode: "custom" });
    expect(observed.guard.canCommit()).toBe(false);
    expect(edits).toEqual([]);
  });

  it("keeps sorted manual pins available while rejecting ordinary and stale-mode drops", () => {
    useSidebarViewStore.setState({ workspaceSortMode: "name" });
    const observed = observedGuard("workspace");
    stop = observed.stop;
    observed.guard.begin(renderedContext("workspace"));
    expect(observed.guard.canCommit()).toBe(false);
    expect(observed.guard.canCommit(true)).toBe(true);
    useSidebarViewStore.setState({ groupMode: "status" });
    expect(observed.guard.canCommit(true)).toBe(false);
  });

  it("invalidates a started reorder when transient quick text changes away and back", () => {
    const query = useSidebarQuickFilterStore.getState();
    query.toggle("project");
    const observed = observedGuard("workspace");
    stop = () => {
      observed.stop();
      useSidebarQuickFilterStore.getState().close("project");
    };
    observed.guard.begin(renderedContext("workspace"));
    expect(observed.guard.canCommit()).toBe(true);
    query.setText("project", "narrow");
    query.setText("project", "");
    expect(observed.guard.canCommit()).toBe(false);
  });

  it.each(["project", "status"] as const)(
    "admits a fresh %s pin drag under sorting but not one whose filter changed mid-gesture",
    (mode) => {
      const query = useSidebarQuickFilterStore.getState();
      query.toggle(mode);
      useSidebarViewStore.setState({
        groupMode: mode,
        sortMode: "status",
        workspaceSortMode: "name",
      });
      const observed = observedGuard("workspace");
      stop = () => {
        observed.stop();
        useSidebarQuickFilterStore.getState().close(mode);
      };
      observed.guard.begin(renderedContext("workspace"));
      expect(observed.guard.canCommit(true)).toBe(true);
      observed.guard.begin(renderedContext("workspace"));
      query.setText(mode, "narrow");
      query.setText(mode, "");
      expect(observed.guard.canCommit(true)).toBe(false);
    },
  );

  it("admits nothing from a stale rendered context", () => {
    const guard = createSidebarReorderGuard("project");
    guard.begin("an older render");
    expect(guard.canCommit(true)).toBe(false);
  });
});

describe.each(["created", "lastPrompt"] as const)(
  "project workspace drags under the %s workspace sort",
  (automaticSort) => {
    let stop: () => void = () => {};
    beforeEach(() => {
      useSidebarViewStore.setState({
        groupMode: "project",
        workspaceSortMode: "custom",
        workspaceSort: "manual",
      });
    });
    afterEach(() => {
      stop();
      useSidebarViewStore.setState({ groupMode: "project", workspaceSort: "manual" });
    });

    it("rejects a Manual drag after the sort flips away and back", () => {
      const observed = observedGuard("workspace");
      stop = observed.stop;
      observed.guard.begin(renderedContext("workspace"));
      expect(observed.guard.canCommit()).toBe(true);
      useSidebarViewStore.setState({ workspaceSort: automaticSort });
      useSidebarViewStore.setState({ workspaceSort: "manual" });
      expect(observed.guard.canCommit()).toBe(false);
    });

    it("admits a fresh pin gesture but no ordinary drop while the sort is automatic", () => {
      useSidebarViewStore.setState({ workspaceSort: automaticSort });
      const observed = observedGuard("workspace");
      stop = observed.stop;
      observed.guard.begin(renderedContext("workspace"));
      expect(observed.guard.canCommit()).toBe(false);
      expect(observed.guard.canCommit(true)).toBe(true);
    });

    it("rejects a pin gesture started under the automatic sort once Manual returns", () => {
      useSidebarViewStore.setState({ workspaceSort: automaticSort });
      const observed = observedGuard("workspace");
      stop = observed.stop;
      observed.guard.begin(renderedContext("workspace"));
      useSidebarViewStore.setState({ workspaceSort: "manual" });
      expect(observed.guard.canCommit(true)).toBe(false);
    });

    it("leaves Status grouping on its own Custom workspace order", () => {
      useSidebarViewStore.setState({ groupMode: "status", workspaceSort: automaticSort });
      const observed = observedGuard("workspace");
      stop = observed.stop;
      observed.guard.begin(renderedContext("workspace"));
      expect(observed.guard.canCommit()).toBe(true);
    });
  },
);
