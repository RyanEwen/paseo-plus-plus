import assert from "node:assert/strict";
import test from "node:test";
import { npmInvocation } from "./npm.mjs";

test("starts npm.cmd through a shell only on Windows", () => {
  assert.deepEqual(npmInvocation("win32"), { command: "npm.cmd", shell: true });
  assert.deepEqual(npmInvocation("linux"), { command: "npm", shell: false });
  assert.deepEqual(npmInvocation("darwin"), { command: "npm", shell: false });
});
