import { describe, expect, it } from "vitest";

import { commandActivityMetadata, fileChangeActivityMetadata } from "./tool-activity-metadata.js";

describe("codex tool activity metadata", () => {
  it("carries valid command actions and nothing for missing or malformed ones", () => {
    const actions = [{ type: "read", command: "cat a.ts", name: "a.ts", path: "a.ts" }];
    expect(commandActivityMetadata(actions)).toEqual({ metadata: { commandActions: actions } });
    expect(commandActivityMetadata(undefined)).toEqual({});
    expect(commandActivityMetadata([])).toEqual({});
    expect(commandActivityMetadata([{ type: "read", command: "cat" }])).toEqual({});
  });

  it("lists every file and keeps unproven kinds generic", () => {
    expect(
      fileChangeActivityMetadata([
        { path: "a.ts", kind: "add", diff: "+a" },
        { path: "b.ts", kind: "update", diff: "-b\n+c" },
        { path: "c.ts", kind: "delete", diff: "-c" },
        { path: "d.ts", kind: "future", diff: "x" },
        { path: "e.ts" },
      ]),
    ).toEqual({
      metadata: {
        fileChanges: [
          { path: "a.ts", kind: "add", diff: "+a" },
          { path: "b.ts", kind: "update", diff: "-b\n+c" },
          { path: "c.ts", kind: "delete", diff: "-c" },
          { path: "d.ts", kind: "unknown", diff: "x" },
          { path: "e.ts", kind: "unknown" },
        ],
      },
    });
  });

  it("emits no metadata for a patch without files", () => {
    expect(fileChangeActivityMetadata([])).toEqual({});
  });
});
