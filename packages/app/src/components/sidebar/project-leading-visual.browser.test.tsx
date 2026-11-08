import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectStatusIndicator } from "./project-leading-visual";

interface MountedIndicator {
  root: Root;
  container: HTMLDivElement;
}

const mountedIndicators: MountedIndicator[] = [];

function mountIndicator(statusHiddenFromAccessibility: boolean): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() =>
    root.render(
      <ProjectStatusIndicator
        iconDataUri={null}
        displayName="Project"
        projectViewKey="project"
        statusBucket="failed"
        backdrop="surfaceSidebar"
        statusHiddenFromAccessibility={statusHiddenFromAccessibility}
      />,
    ),
  );
  mountedIndicators.push({ root, container });
  return container;
}

function ariaHiddenOf(container: HTMLElement, testID: string): string | null {
  const element = container.querySelector(`[data-testid="${testID}"]`);
  if (!element) {
    throw new Error(`Missing ${testID}`);
  }
  return element.getAttribute("aria-hidden");
}

afterEach(() => {
  for (const mounted of mountedIndicators.splice(0)) {
    act(() => mounted.root.unmount());
    mounted.container.remove();
  }
});

describe("ProjectStatusIndicator accessibility", () => {
  it("hides only the status badge when a chip announces the status", () => {
    const container = mountIndicator(true);

    expect(ariaHiddenOf(container, "project-status-badge")).toBe("true");
    expect(ariaHiddenOf(container, "project-status-indicator-failed")).not.toBe("true");
  });

  it("keeps the status badge announced without a chip", () => {
    const container = mountIndicator(false);

    expect(ariaHiddenOf(container, "project-status-badge")).not.toBe("true");
  });
});
