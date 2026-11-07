/**
 * @vitest-environment jsdom
 */
import { i18n as testI18n } from "@/i18n/i18next";
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MenuRoot } from "@/components/ui/menu/menu-root";
import {
  ExplorerIconOnlyMenuItem,
  type ExplorerTabDisplayControl,
} from "@/screens/workspace/explorer-tab-display";

void testI18n;

afterEach(cleanup);

beforeEach(() => vi.stubGlobal("React", React));

function displayControl(overrides: Partial<ExplorerTabDisplayControl> = {}) {
  return {
    enabled: true,
    disabled: false,
    pending: false,
    failed: false,
    toggle: vi.fn(),
    ...overrides,
  };
}

describe("ExplorerIconOnlyMenuItem", () => {
  // The compact menu sheet is a portal that carries only the menu's own contexts, so the row
  // must work from its props alone, with no provider between it and the tab row.
  it("renders the checked toggle from its control prop without an ancestor provider", () => {
    const control = displayControl();
    const view = render(
      <MenuRoot defaultOpen>
        <ExplorerIconOnlyMenuItem control={control} />
      </MenuRoot>,
    );

    const row = view.getByRole("menuitem", { name: "Icon-only tabs" });
    expect(row.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(row);
    expect(control.toggle).toHaveBeenCalledTimes(1);
  });

  it("renders nothing outside the Explorer", () => {
    const view = render(
      <MenuRoot defaultOpen>
        <ExplorerIconOnlyMenuItem control={null} />
      </MenuRoot>,
    );

    expect(view.queryByRole("menuitem", { name: "Icon-only tabs" })).toBeNull();
  });
});
