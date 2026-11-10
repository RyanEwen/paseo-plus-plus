/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, render } from "@testing-library/react";
import { Text } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExplorerTabStripContextMenu } from "@/screens/workspace/explorer-tab-display";

vi.mock("@/constants/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/constants/platform")>()),
  isNative: true,
}));

afterEach(cleanup);

beforeEach(() => vi.stubGlobal("React", React));

const control = {
  enabled: false,
  disabled: false,
  pending: false,
  failed: false,
  toggle: () => undefined,
};

describe("ExplorerTabStripContextMenu on native", () => {
  // The strip menu cannot open on native. A trigger wrapper there collapses to zero height inside
  // the rail, so the tab strip overflows under the Explorer panel's divider and content.
  it("renders the tab strip directly, without the context menu trigger", () => {
    const view = render(
      <ExplorerTabStripContextMenu control={control}>
        <Text testID="explorer-tab-strip">Tabs</Text>
      </ExplorerTabStripContextMenu>,
    );

    expect(view.container.firstElementChild?.getAttribute("data-testid")).toBe(
      "explorer-tab-strip",
    );
  });
});
