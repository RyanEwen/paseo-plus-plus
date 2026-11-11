import React, { act } from "react";
import { Text } from "react-native";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarSectionHeader } from "./sidebar-section-header";

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

function noop() {}

const chooserTitle = <Text testID="element-title">All Workspaces</Text>;

/** Render a Pinned heading and an element-titled heading in one column, as the sidebar list does. */
function mountHeadings(): HTMLDivElement {
  const container = document.createElement("div");
  container.style.width = "280px";
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <>
        <SidebarSectionHeader
          title="Pinned"
          collapsed={false}
          onToggle={noop}
          testID="pinned-heading"
        />
        <SidebarSectionHeader title={chooserTitle}>
          <Text testID="heading-action">Display</Text>
        </SidebarSectionHeader>
      </>,
    ),
  );
  mounted.push({ root, container });
  return container;
}

/** The left edge of the first text run inside the element with `testID`. */
function textLeft(container: HTMLElement, testID: string): number {
  const element = container.querySelector(`[data-testid="${testID}"]`);
  if (!(element instanceof HTMLElement)) throw new Error(`Missing ${testID}`);
  const range = document.createRange();
  range.selectNodeContents(element);
  return range.getBoundingClientRect().left;
}

describe("SidebarSectionHeader element title", () => {
  it("places an element title on the same rail as a text title", () => {
    const container = mountHeadings();
    expect(textLeft(container, "element-title")).toBeCloseTo(
      textLeft(container, "pinned-heading"),
      0,
    );
  });

  it("keeps trailing actions beside an element title", () => {
    const container = mountHeadings();
    expect(container.querySelector('[data-testid="heading-action"]')).not.toBeNull();
  });
});
