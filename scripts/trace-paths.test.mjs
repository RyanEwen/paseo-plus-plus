import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createTraceIgnore } from "./trace-paths.mjs";

test("trace boundaries reject external Windows volumes and preserve checkout dependencies", () => {
  const ignore = createTraceIgnore(["**/*.test.js", "node_modules/electron/**"], path.win32);
  const checkout = "D:\\a\\paseo\\paseo";
  for (const external of [
    "C:\\Users\\runneradmin\\Documents",
    "D:\\a\\private\\credentials.json",
    "\\\\server\\share\\config.js",
  ]) {
    assert.equal(ignore(path.win32.relative(checkout, external)), true, external);
  }
  assert.equal(ignore(".."), true);
  assert.equal(ignore("packages\\server\\dist\\index.js"), false);
  assert.equal(ignore("node_modules\\node-pty\\build\\Release\\conpty.node"), false);
  assert.equal(ignore("packages\\server\\dist\\index.test.js"), true);
  assert.equal(ignore("node_modules\\electron\\index.js"), true);
});

test("trace boundaries retain POSIX files and existing exclusions", () => {
  const ignore = createTraceIgnore(["**/*.test.js"], path.posix);
  assert.equal(ignore("/home/runner/private.json"), true);
  assert.equal(ignore("../private.json"), true);
  assert.equal(ignore("packages/server/dist/index.js"), false);
  assert.equal(ignore("packages/server/dist/index.test.js"), true);
});
