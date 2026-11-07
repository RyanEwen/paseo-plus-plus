import { describe, expect, it } from "vitest";

import {
  describeToolActivity,
  parseCommandActions,
  parseFileChanges,
} from "./tool-call-activity.js";

describe("provider-neutral activity classification", () => {
  it("classifies canonical details without relying on provider-specific tool names", () => {
    expect(describeToolActivity({ detail: { type: "read", filePath: "../a.ts" } })).toEqual([
      { kind: "read", target: "../a.ts" },
    ]);
    expect(
      describeToolActivity({
        detail: { type: "edit", filePath: "a.ts", oldString: "x", newString: "y" },
      }),
    ).toEqual([{ kind: "edit", target: "a.ts" }]);
    expect(
      describeToolActivity({ detail: { type: "write", filePath: "a.ts", content: "x" } }),
    ).toEqual([{ kind: "write", target: "a.ts" }]);
    expect(describeToolActivity({ detail: { type: "search", query: "needle" } })).toEqual([
      { kind: "search", target: "needle" },
    ]);
  });

  it("recognizes script invocations without interpreting effects or compound scripts", () => {
    expect(describeToolActivity({ detail: { type: "shell", command: "npm run test" } })).toEqual([
      { kind: "script", target: "npm run test" },
    ]);
    expect(
      describeToolActivity({ detail: { type: "shell", command: "npm run test && rm a.ts" } }),
    ).toEqual([{ kind: "command" }]);
    expect(describeToolActivity({ detail: { type: "shell", command: "cat a.ts b.ts" } })).toEqual([
      { kind: "command" },
    ]);
  });

  it("keeps future patch kinds generic rather than claiming creation or writing", () => {
    expect(
      describeToolActivity({
        detail: { type: "unknown", input: null, output: null },
        metadata: { fileChanges: [{ path: "future.ts", kind: "unknown", diff: "opaque" }] },
      }),
    ).toEqual([{ kind: "change", target: "future.ts" }]);
  });

  it("describes every file in a patch batch by its proven kind", () => {
    expect(
      describeToolActivity({
        detail: { type: "edit", filePath: "a.ts" },
        metadata: {
          fileChanges: [
            { path: "a.ts", kind: "add", diff: "+a" },
            { path: "b.ts", kind: "update", diff: "-b\n+c" },
            { path: "c.ts", kind: "delete", diff: "-c" },
          ],
        },
      }),
    ).toEqual([
      { kind: "create", target: "a.ts" },
      { kind: "edit", target: "b.ts" },
      { kind: "delete", target: "c.ts" },
    ]);
  });

  it("ignores file-change metadata on details that are not file changes", () => {
    expect(
      describeToolActivity({
        detail: { type: "search", query: "needle" },
        metadata: { fileChanges: [{ path: "a.ts", kind: "add" }] },
      }),
    ).toEqual([{ kind: "search", target: "needle" }]);
  });

  it("maps structured command actions and falls back to the command for unknown actions", () => {
    expect(
      describeToolActivity({
        detail: { type: "shell", command: "cat a.ts; ls src; rg needle; make" },
        metadata: {
          commandActions: [
            { type: "read", command: "cat a.ts", name: "a.ts", path: "a.ts" },
            { type: "listFiles", command: "ls src", path: "src" },
            { type: "search", command: "rg needle", query: "needle", path: null },
            { type: "search", command: "rg", query: null, path: "lib" },
            { type: "unknown", command: "npm run build" },
          ],
        },
      }),
    ).toEqual([
      { kind: "read", target: "a.ts" },
      { kind: "list", target: "src" },
      { kind: "search", target: "needle" },
      { kind: "search", target: "lib" },
      { kind: "script", target: "npm run build" },
    ]);
  });

  it("returns no activity for details it cannot classify", () => {
    expect(describeToolActivity({ detail: { type: "unknown", input: null, output: null } })).toEqual(
      [],
    );
  });
});

describe("provider metadata validation", () => {
  it("rejects empty, malformed and non-array batches as a whole", () => {
    expect(parseCommandActions([])).toBeUndefined();
    expect(parseCommandActions("cat a.ts")).toBeUndefined();
    expect(
      parseCommandActions([
        { type: "read", command: "cat a.ts", name: "a.ts", path: "a.ts" },
        { type: "future", command: "x" },
      ]),
    ).toBeUndefined();
    expect(parseFileChanges([])).toBeUndefined();
    expect(parseFileChanges({ path: "a.ts", kind: "add" })).toBeUndefined();
    expect(
      parseFileChanges([
        { path: "a.ts", kind: "add" },
        { path: "", kind: "update" },
      ]),
    ).toBeUndefined();
  });

  it("returns valid batches unchanged", () => {
    const actions = [{ type: "read", command: "cat a.ts", name: "a.ts", path: "a.ts" }];
    const files = [{ path: "a.ts", kind: "update", diff: "-a\n+b" }];
    expect(parseCommandActions(actions)).toEqual(actions);
    expect(parseFileChanges(files)).toEqual(files);
  });
});
