import { describe, expect, it } from "vitest";
import { resolveProjectLeadingStatus } from "./project-leading-status";

const BUCKETS = ["running", "needs_input", "failed", "attention", "done", null] as const;
const NON_RUNNING_BUCKETS = ["needs_input", "failed", "attention", "done", null] as const;

describe("resolveProjectLeadingStatus without activity chips", () => {
  it.each(BUCKETS)("shows %s on the glyph only while the project is collapsed", (bucket) => {
    expect(resolveProjectLeadingStatus({ bucket, chipsEnabled: false, collapsed: true })).toBe(
      bucket,
    );
    expect(
      resolveProjectLeadingStatus({ bucket, chipsEnabled: false, collapsed: false }),
    ).toBeNull();
  });
});

describe("resolveProjectLeadingStatus with activity chips", () => {
  it.each(NON_RUNNING_BUCKETS)("shows %s whether or not the project is collapsed", (bucket) => {
    expect(resolveProjectLeadingStatus({ bucket, chipsEnabled: true, collapsed: true })).toBe(
      bucket,
    );
    expect(resolveProjectLeadingStatus({ bucket, chipsEnabled: true, collapsed: false })).toBe(
      bucket,
    );
  });

  it("leaves the working ring to the chip", () => {
    expect(
      resolveProjectLeadingStatus({ bucket: "running", chipsEnabled: true, collapsed: true }),
    ).toBeNull();
    expect(
      resolveProjectLeadingStatus({ bucket: "running", chipsEnabled: true, collapsed: false }),
    ).toBeNull();
  });
});
