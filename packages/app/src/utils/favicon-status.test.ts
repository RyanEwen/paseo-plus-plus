import { describe, expect, test } from "vitest";
import { deriveFaviconStatus } from "./favicon-status";

describe("deriveFaviconStatus", () => {
  test.each([
    {
      host: "audience-aware",
      reviewed: { status: "idle", humanAttentionRequired: true, requiresAttention: true },
    },
    { host: "older", reviewed: { status: "idle", requiresAttention: true } },
  ])("a running agent outranks attention on an $host host", ({ reviewed }) => {
    expect(deriveFaviconStatus([reviewed, { status: "running" }])).toBe("running");
  });

  test.each([
    { host: "audience-aware", failed: { status: "error", humanAttentionRequired: true } },
    { host: "older", failed: { status: "error" } },
  ])("a failed agent shows attention on an $host host", ({ failed }) => {
    expect(deriveFaviconStatus([failed])).toBe("attention");
  });

  test("routine agent-directed results stay quiet", () => {
    expect(
      deriveFaviconStatus([
        { status: "idle", humanAttentionRequired: false, requiresAttention: true },
      ]),
    ).toBe("none");
  });
});
