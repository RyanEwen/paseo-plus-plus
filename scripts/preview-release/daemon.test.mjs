import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readTracedDaemonFiles } from "./daemon.mjs";

/** Create a checkout whose trace script prints `lineCount` traced paths from the checkout root. */
function withFakeTraceCheckout(lineCount, run) {
  const root = mkdtempSync(path.join(tmpdir(), "paseo-daemon-trace-"));
  try {
    mkdirSync(path.join(root, "scripts"));
    writeFileSync(
      path.join(root, "scripts/trace-daemon.mjs"),
      [
        'import { writeSync } from "node:fs";',
        `for (let index = 0; index < ${lineCount}; index += 1) {`,
        "  writeSync(1, `packages/server/dist/module-${String(index).padStart(6, '0')}.js\\n`);",
        "}",
        "",
      ].join("\n"),
    );
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("reads every traced daemon path from the checkout's trace script", () => {
  withFakeTraceCheckout(3, (root) => {
    assert.deepEqual(readTracedDaemonFiles(root), [
      "packages/server/dist/module-000000.js",
      "packages/server/dist/module-000001.js",
      "packages/server/dist/module-000002.js",
    ]);
  });
});

test("reads a trace list larger than Node's default 1 MiB output buffer", () => {
  // 40,000 paths of 38 bytes are about 1.45 MiB of stdout.
  withFakeTraceCheckout(40_000, (root) => {
    const files = readTracedDaemonFiles(root);
    assert.equal(files.length, 40_000);
    assert.equal(files.at(-1), "packages/server/dist/module-039999.js");
  });
});
