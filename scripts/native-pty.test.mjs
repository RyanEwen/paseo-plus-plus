import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { loadNativePtyModules, traceNativePtyFiles } from "./native-pty.mjs";

test("daemon tracing and smoke load the native PTY addons used by each platform", () => {
  for (const [platform, expected] of [
    ["linux", ["pty"]],
    ["darwin", ["pty"]],
    ["win32", ["conpty", "conpty_console_list"]],
  ]) {
    const loaded = [];
    const requireModule = (specifier) => {
      assert.equal(specifier, path.resolve("node-pty/lib/utils.js"));
      return {
        loadNativeModule(name) {
          loaded.push(name);
          return { dir: "../build/Release", module: {} };
        },
      };
    };
    requireModule.resolve = (specifier) => {
      assert.equal(specifier, "node-pty/lib/utils");
      return path.resolve("node-pty/lib/utils.js");
    };
    assert.deepEqual(loadNativePtyModules(requireModule, platform), [
      path.resolve("node-pty/build/Release"),
    ]);
    assert.deepEqual(loaded, expected);
  }
});

test("native PTY tracing retains bundled ConPTY files and excludes compiler directories", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "native-pty-trace-"));
  try {
    mkdirSync(path.join(root, "lib"));
    const nativeRoot = path.join(root, "build/Release");
    mkdirSync(path.join(nativeRoot, "conpty"), { recursive: true });
    mkdirSync(path.join(nativeRoot, "obj"));
    const runtimeNames = [
      "conpty.node",
      "conpty_console_list.node",
      "conpty/conpty.dll",
      "conpty/OpenConsole.exe",
    ];
    for (const name of [...runtimeNames, "conpty.pdb", "conpty.lib", "obj/source.obj"]) {
      writeFileSync(path.join(nativeRoot, name), "fixture");
    }
    const requireModule = () => ({ loadNativeModule: () => ({ dir: "../build/Release" }) });
    requireModule.resolve = () => path.join(root, "lib/utils.js");
    const files = await traceNativePtyFiles(requireModule, "win32");
    assert.deepEqual(files.sort(), runtimeNames.map((name) => path.join(nativeRoot, name)).sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
