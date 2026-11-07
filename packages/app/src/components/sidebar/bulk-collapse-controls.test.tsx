/**
 * @vitest-environment jsdom
 */
import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarBulkCollapseControls } from "./bulk-collapse-controls";
import { SIDEBAR_HEADER_TOUCH_TARGET } from "./header-icon-button";

type StyleValue = Record<string, unknown> | false | null | undefined | StyleValue[];

interface TriggerProps {
  testID: string;
  style: (state: { pressed: boolean; hovered: boolean }) => StyleValue;
  children: ReactNode;
}

// Hoisted so the tooltip mock factory can use it before the module body runs.
const { flattenStyle } = vi.hoisted(() => {
  /** Merge a React Native style array into one object, ignoring falsy entries. */
  function flatten(style: StyleValue): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
    return style;
  }
  return { flattenStyle: flatten };
});

vi.mock("@/constants/platform", () => ({ isNative: true, isWeb: false }));
vi.mock("@/constants/layout", () => ({ useIsCompactFormFactor: () => false }));
// The compact menu items are not under test here; keep the menu engine out of the module graph.
vi.mock("@/components/ui/menu", () => ({ MenuItem: () => null, MenuSeparator: () => null }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("./use-sidebar-bulk-collapse", () => ({
  useSidebarBulkCollapse: () => ({ enabled: true, expandAll: vi.fn(), collapseAll: vi.fn() }),
}));
// Render the trigger as a plain element that records its resting style for the assertions.
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipContent: () => null,
  TooltipTrigger: ({ testID, style, children }: TriggerProps) => (
    <div
      data-testid={testID}
      data-style={JSON.stringify(flattenStyle(style({ pressed: false, hovered: false })))}
    >
      {children}
    </div>
  ),
}));

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function restingStyle(testID: string): Record<string, unknown> {
  const element = container!.querySelector(`[data-testid="${testID}"]`);
  return JSON.parse(element?.getAttribute("data-style") ?? "{}");
}

describe("sidebar bulk collapse header buttons", () => {
  it("give both buttons the 44 px header touch target on native wide layouts", async () => {
    await act(() => root?.render(<SidebarBulkCollapseControls />));
    expect(SIDEBAR_HEADER_TOUCH_TARGET).toBe(44);
    for (const testID of ["sidebar-expand-all", "sidebar-collapse-all"]) {
      expect(restingStyle(testID)).toMatchObject({
        minWidth: SIDEBAR_HEADER_TOUCH_TARGET,
        minHeight: SIDEBAR_HEADER_TOUCH_TARGET,
      });
    }
  });
});
