import { describe, expect, it } from "vitest";
import type { MobilePanelView } from "@/stores/panel-store";
import { createCompactPanelBackHandler, resolveCompactBackTarget } from "./compact-back";

/** An in-memory compact panel that records every panel Back showed. */
function makePanels(initial: MobilePanelView) {
  let current = initial;
  const shown: MobilePanelView[] = [];

  return {
    shown,
    current: () => current,
    navigator: {
      currentTarget: () => current,
      show(target: MobilePanelView) {
        current = target;
        shown.push(target);
      },
    },
  };
}

describe("resolveCompactBackTarget", () => {
  it("opens the sidebar from the agent", () => {
    expect(resolveCompactBackTarget("agent")).toBe("agent-list");
  });

  it("returns to the agent from the explorer", () => {
    expect(resolveCompactBackTarget("file-explorer")).toBe("agent");
  });

  it("leaves Back to the navigator from the open sidebar", () => {
    expect(resolveCompactBackTarget("agent-list")).toBeNull();
  });
});

describe("createCompactPanelBackHandler", () => {
  it("claims the press when it shows another panel", () => {
    const panels = makePanels("agent");
    const handleBack = createCompactPanelBackHandler(panels.navigator);

    expect(handleBack()).toBe(true);
    expect(panels.shown).toEqual(["agent-list"]);
  });

  it("closes the explorer before opening the sidebar", () => {
    const panels = makePanels("file-explorer");
    const handleBack = createCompactPanelBackHandler(panels.navigator);

    expect(handleBack()).toBe(true);
    expect(handleBack()).toBe(true);
    expect(panels.shown).toEqual(["agent", "agent-list"]);
  });

  it("lets Back leave the workspace once the sidebar is open", () => {
    const panels = makePanels("agent");
    const handleBack = createCompactPanelBackHandler(panels.navigator);

    expect(handleBack()).toBe(true);
    expect(handleBack()).toBe(false);
    expect(handleBack()).toBe(false);
    expect(panels.shown).toEqual(["agent-list"]);
    expect(panels.current()).toBe("agent-list");
  });
});
