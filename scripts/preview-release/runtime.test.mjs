import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { stageDaemonRuntime } from "./runtime.mjs";

test("daemon workspace aliases contain traced files and web assets without source or ignored files", () => {
  const root = mkdtempSync(path.join(tmpdir(), "paseo-daemon-runtime-"));
  const output = path.join(root, "staged");
  try {
    const server = path.join(root, "packages/server");
    const webUi = path.join(server, "dist/server/web-ui");
    mkdirSync(webUi, { recursive: true });
    writeFileSync(
      path.join(server, "package.json"),
      JSON.stringify({ name: "@getpaseo/server", files: ["src/vendor/LICENSE"] }),
    );
    writeFileSync(path.join(server, "LICENSE"), "package-license");
    writeFileSync(path.join(server, "NOTICE"), "package-notice");
    writeFileSync(path.join(server, "dist/server/entry.js"), "export const daemon = true;");
    writeFileSync(path.join(webUi, "index.html"), "web-client");
    writeFileSync(path.join(server, ".env"), "DO_NOT_SHIP=fixture");
    mkdirSync(path.join(server, "src/vendor"), { recursive: true });
    writeFileSync(path.join(server, "src/vendor/LICENSE"), "vendor-license");
    writeFileSync(path.join(server, "src/ignored.test.ts"), "development-only");
    mkdirSync(path.join(root, "node_modules/@getpaseo"), { recursive: true });
    symlinkSync(server, path.join(root, "node_modules/@getpaseo/server"), "junction");
    stageDaemonRuntime({
      root,
      output,
      files: [
        "node_modules/@getpaseo/server",
        "packages/server/package.json",
        "packages/server/dist/server/entry.js",
      ],
    });
    for (const location of ["packages/server", "node_modules/@getpaseo/server"]) {
      const shipped = path.join(output, location);
      assert.equal(
        readFileSync(path.join(shipped, "dist/server/entry.js"), "utf8"),
        "export const daemon = true;",
      );
      assert.equal(
        readFileSync(path.join(shipped, "dist/server/web-ui/index.html"), "utf8"),
        "web-client",
      );
      assert.equal(existsSync(path.join(shipped, ".env")), false);
      assert.equal(existsSync(path.join(shipped, "src/ignored.test.ts")), false);
      assert.equal(readFileSync(path.join(shipped, "LICENSE"), "utf8"), "package-license");
      assert.equal(readFileSync(path.join(shipped, "NOTICE"), "utf8"), "package-notice");
      assert.equal(
        readFileSync(path.join(shipped, "src/vendor/LICENSE"), "utf8"),
        "vendor-license",
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
