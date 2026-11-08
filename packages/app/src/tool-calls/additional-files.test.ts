import { describe, expect, it } from "vitest";

import { additionalFileDiffLines, splitReadableFileBatch } from "./additional-files";

const edit = { type: "edit", filePath: "/work/a.ts" } as const;
const metadata = {
  fileChanges: [
    { path: "/work/a.ts", kind: "update", diff: "-a\n+b" },
    { path: "/work/b.ts", kind: "update", diff: "-c\n+d" },
  ],
};

describe("splitReadableFileBatch", () => {
  it("leaves the canonical file out of the additional files", () => {
    const batch = splitReadableFileBatch(edit, { readable: true, metadata, cwd: "/work" });
    expect(batch.detail).toBe(edit);
    expect(batch.additionalFiles.map((file) => file.path)).toEqual(["/work/b.ts"]);
  });

  it("changes nothing with readable activity off, one file, or a Paseo message", () => {
    const single = { fileChanges: metadata.fileChanges.slice(0, 1) };
    for (const input of [
      { readable: false, metadata },
      { readable: true, metadata: single },
      { readable: true, metadata, agentMessage: { event: "message" } },
    ]) {
      expect(splitReadableFileBatch(edit, input)).toEqual({ detail: edit, additionalFiles: [] });
    }
  });
});

describe("additionalFileDiffLines", () => {
  it("renders update hunks as real diff rows", () => {
    expect(additionalFileDiffLines({ kind: "update", diff: "@@ -1 +1 @@\n-a\n+b" })).toEqual([
      expect.objectContaining({ type: "header", content: "@@ -1 +1 @@" }),
      expect.objectContaining({ type: "remove", content: "-a" }),
      expect.objectContaining({ type: "add", content: "+b" }),
    ]);
  });

  it("renders plain added and deleted file content as added and removed rows", () => {
    expect(additionalFileDiffLines({ kind: "add", diff: "one\r\n+two\n" })).toEqual([
      { type: "add", content: "+one" },
      { type: "add", content: "++two" },
    ]);
    expect(additionalFileDiffLines({ kind: "delete", diff: "gone" })).toEqual([
      { type: "remove", content: "-gone" },
    ]);
  });

  it("keeps a unified diff for added files and has no rows without a diff", () => {
    expect(
      additionalFileDiffLines({
        kind: "add",
        diff: "--- /dev/null\n+++ b/a.ts\n@@ -0,0 +1 @@\n+a",
      }).map((line) => line.type),
    ).toEqual(["header", "add"]);
    expect(additionalFileDiffLines({ kind: "update", diff: undefined })).toEqual([]);
  });
});
