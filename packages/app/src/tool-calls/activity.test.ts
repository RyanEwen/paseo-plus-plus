import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { createInstance } from "i18next";
import { describe, expect, it } from "vitest";
import { en } from "@/i18n/resources/en";
import type { ToolCallDisplayInput } from "@/utils/tool-call-display";

import { buildActivityDisplay } from "./activity";

const translation = createInstance();
void translation.init({ lng: "en", resources: { en: { translation: en } }, initAsync: false });

/** A completed call in /work with the given detail and optional provider metadata. */
function display(
  detail: ToolCallDetail,
  overrides: Partial<ToolCallDisplayInput> = {},
): ReturnType<typeof buildActivityDisplay> {
  return buildActivityDisplay(
    { name: "tool", status: "completed", error: null, cwd: "/work", detail, ...overrides },
    translation.t,
  );
}

const shell = (command: string, commandActions: unknown[]): Partial<ToolCallDisplayInput> => ({
  detail: { type: "shell", command },
  metadata: { commandActions },
});

describe("readable activity display", () => {
  it("names a single canonical operation by its kind", () => {
    expect(display({ type: "read", filePath: "/work/a.ts" })).toEqual({
      displayName: "Read",
      summary: "a.ts",
      kind: "read",
    });
    expect(display({ type: "search", query: "/work/needle" })).toEqual({
      displayName: "Searched",
      summary: "/work/needle",
      kind: "search",
    });
    expect(display({ type: "shell", command: "npm run test" })).toEqual({
      displayName: "Ran script",
      summary: "npm run test",
      kind: "script",
    });
  });

  it("names the state of the operation and wraps failed and canceled attempts", () => {
    const detail: ToolCallDetail = { type: "edit", filePath: "/work/a.ts" };
    expect(display(detail, { status: "running" })?.displayName).toBe("Editing");
    expect(display(detail, { status: "failed" })?.displayName).toBe("Failed: Edit");
    expect(display(detail, { status: "canceled" })?.displayName).toBe("Canceled: Edit");
  });

  it("groups mixed or generic file changes as file changes", () => {
    const patch: ToolCallDetail = { type: "edit", filePath: "/work/a.ts" };
    expect(
      display(patch, {
        metadata: {
          fileChanges: [
            { path: "/work/a.ts", kind: "add" },
            { path: "/work/b.ts", kind: "update" },
          ],
        },
      }),
    ).toEqual({ displayName: "Changed files", summary: "a.ts, b.ts", kind: "files" });
    expect(
      display(patch, { metadata: { fileChanges: [{ path: "/work/a.ts", kind: "unknown" }] } }),
    ).toEqual({ displayName: "Changed files", summary: "a.ts", kind: "files" });
    expect(
      display(patch, {
        metadata: {
          fileChanges: [
            { path: "/work/a.ts", kind: "add" },
            { path: "/work/b.ts", kind: "add" },
          ],
        },
      }),
    ).toEqual({ displayName: "Created", summary: "a.ts, b.ts", kind: "create" });
  });

  it("calls a mix of different non-file operations generic activity", () => {
    const mixed = shell("cat a.ts && rg needle", [
      { type: "read", command: "cat a.ts", name: "a.ts", path: "/work/a.ts" },
      { type: "search", command: "rg needle", query: "needle" },
    ]);
    expect(display(mixed.detail as ToolCallDetail, mixed)).toEqual({
      displayName: "Ran operations",
      summary: "a.ts, needle",
      kind: "activity",
    });
  });

  it("strips the working directory from path targets only and removes duplicates", () => {
    const listing = shell("ls; ls; cat a.ts", [
      { type: "listFiles", command: "ls", path: "/work/src" },
      { type: "listFiles", command: "ls", path: "/work/src" },
    ]);
    expect(display(listing.detail as ToolCallDetail, listing)).toEqual({
      displayName: "Listed files",
      summary: "src",
      kind: "list",
    });
    const untargeted = shell("ls", [{ type: "listFiles", command: "ls" }]);
    expect(display(untargeted.detail as ToolCallDetail, untargeted)?.summary).toBeUndefined();
  });

  it("leaves Paseo messages and unclassified details to the classic labels", () => {
    expect(
      display(
        { type: "unknown", input: null, output: null },
        { agentMessage: { event: "message", text: "hi" } as ToolCallDisplayInput["agentMessage"] },
      ),
    ).toBeUndefined();
    expect(display({ type: "unknown", input: null, output: null })).toBeUndefined();
  });
});
