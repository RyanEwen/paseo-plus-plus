import { describe, expect, it } from "vitest";
import { emptyProjectsChoice, resolvePreferenceAvailability } from "./preference-state";

describe("emptyProjectsChoice", () => {
  it.each([
    ["all", false, "show"],
    ["all", true, "group"],
    ["unarchived", false, "hide"],
    ["unarchived", true, "hide"],
  ] as const)("maps %s visibility with grouping %s to %s", (visibility, group, choice) => {
    expect(emptyProjectsChoice(visibility, group)).toBe(choice);
  });
});

describe("resolvePreferenceAvailability", () => {
  const writable = {
    blocked: false,
    ready: true,
    unsupported: false,
    canWrite: true,
    syncStatus: "ready",
    error: null,
    pending: false,
  };

  it("allows edits with no reason when settings are writable and idle", () => {
    expect(resolvePreferenceAvailability(writable)).toEqual({ disabled: false, reason: null });
  });

  it("reports a pending save, and the last error once the save has failed", () => {
    expect(resolvePreferenceAvailability({ ...writable, pending: true }).reason).toBe(
      "Saving sidebar preferences",
    );
    expect(
      resolvePreferenceAvailability({ ...writable, pending: true, error: "Write refused" }),
    ).toEqual({ disabled: false, reason: "Write refused" });
  });

  it.each([{ blocked: true }, { ready: false }, { canWrite: false }, { syncStatus: "loading" }])(
    "blocks edits until settings are writable: %o",
    (change) => {
      expect(resolvePreferenceAvailability({ ...writable, ...change, error: "old" })).toEqual({
        disabled: true,
        reason: "Load writable settings before editing",
      });
    },
  );

  it("names an unsupported settings host before any other reason", () => {
    expect(
      resolvePreferenceAvailability({
        ...writable,
        unsupported: true,
        ready: false,
        pending: true,
      }),
    ).toEqual({ disabled: true, reason: "Update the settings host to use separate sidebar modes" });
  });
});
