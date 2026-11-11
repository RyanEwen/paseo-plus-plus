import path from "node:path";
import { describe, expect, test } from "vitest";
import { containsPath, pathsOverlap, strictlyContainsPath } from "./paths.js";

const root = path.resolve("/history-root");

describe("history path containment", () => {
  test.each([
    { child: root, contains: true, strictly: false },
    { child: path.join(root, "projects", "a.jsonl"), contains: true, strictly: true },
    { child: path.join(root, "..", "history-root-other"), contains: false, strictly: false },
    { child: path.resolve("/elsewhere"), contains: false, strictly: false },
    { child: path.join(root, "..", "history-root", "x"), contains: true, strictly: true },
  ])("$child against the root", ({ child, contains, strictly }) => {
    expect(containsPath(root, child)).toBe(contains);
    expect(strictlyContainsPath(root, child)).toBe(strictly);
  });

  test("roots overlap when either contains the other", () => {
    expect(pathsOverlap(root, path.join(root, "nested"))).toBe(true);
    expect(pathsOverlap(path.join(root, "nested"), root)).toBe(true);
    expect(pathsOverlap(root, path.resolve("/history-root-sibling"))).toBe(false);
  });
});
