import { describe, expect, it } from "vitest";
import { resolveWorkspaceLeadingSlot } from "./project-pin-gutter";

const ordinary = { hasProjectIcon: false, loading: false, reserveIdleSpace: true };

describe("workspace leading slot for the project pin marker", () => {
  // The marker becomes a corner badge for "project" and "status", so it never covers a glyph.
  it.each(["running", "needs_input", "attention", "failed"] as const)(
    "reports a %s status glyph in the slot",
    (bucket) => {
      expect(resolveWorkspaceLeadingSlot({ ...ordinary, bucket })).toBe("status");
    },
  );

  it("reports the operation loader as a status glyph", () => {
    expect(resolveWorkspaceLeadingSlot({ ...ordinary, loading: true, bucket: "done" })).toBe(
      "status",
    );
  });

  it("reports a leading project icon before any status", () => {
    expect(
      resolveWorkspaceLeadingSlot({ ...ordinary, hasProjectIcon: true, bucket: "running" }),
    ).toBe("project");
  });

  it("lets the pin take a done row's idle dot", () => {
    expect(resolveWorkspaceLeadingSlot({ ...ordinary, bucket: "done" })).toBe("idle");
  });

  it("reports an empty slot for a done row without reserved idle space", () => {
    expect(
      resolveWorkspaceLeadingSlot({ ...ordinary, reserveIdleSpace: false, bucket: "done" }),
    ).toBe("none");
  });
});
