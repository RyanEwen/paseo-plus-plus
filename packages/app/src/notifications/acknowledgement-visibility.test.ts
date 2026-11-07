import { describe, expect, it } from "vitest";
import {
  canAcknowledgeWorkspace,
  type AcknowledgementVisibility,
} from "./acknowledgement-visibility";

const shown: AcknowledgementVisibility = {
  foreground: true,
  panelVisible: true,
  focused: true,
  hasReceipts: true,
  compact: false,
  centerVisible: false,
  centerRequested: false,
  settled: false,
};

describe("workspace acknowledgement visibility", () => {
  it("admits a shown workspace on a wide layout regardless of compact pane state", () => {
    expect(canAcknowledgeWorkspace(shown)).toBe(true);
  });

  it.each(["foreground", "panelVisible", "focused", "hasReceipts"] as const)(
    "refuses when %s is false",
    (signal) => {
      expect(canAcknowledgeWorkspace({ ...shown, [signal]: false })).toBe(false);
    },
  );

  it("requires the compact agent pane to be active, requested and at rest", () => {
    const compact = { ...shown, compact: true, centerVisible: true, centerRequested: true };
    expect(canAcknowledgeWorkspace({ ...compact, settled: true })).toBe(true);
    expect(canAcknowledgeWorkspace({ ...compact, settled: false })).toBe(false);
    expect(canAcknowledgeWorkspace({ ...compact, settled: true, centerVisible: false })).toBe(
      false,
    );
    expect(canAcknowledgeWorkspace({ ...compact, settled: true, centerRequested: false })).toBe(
      false,
    );
  });
});
