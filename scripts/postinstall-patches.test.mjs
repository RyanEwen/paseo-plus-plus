import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const script = path.resolve("scripts", "postinstall-patches.mjs");
const bin = path.resolve("node_modules", ".bin");
const packageName = "react-native-draggable-flatlist";
const patchFile = `${packageName}+4.0.3.patch`;

function createCheckout() {
  const root = mkdtempSync(path.join(tmpdir(), "postinstall-patches-"));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "checkout" }));
  const packageDir = path.join(root, "node_modules", packageName);
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name: packageName, version: "4.0.3" }),
  );
  writeFileSync(path.join(packageDir, "index.js"), "export const value = 1;\n");
  mkdirSync(path.join(root, "patches"));
  return { root, packageDir };
}

function writePatch(root, from, to) {
  const file = `node_modules/${packageName}/index.js`;
  writeFileSync(
    path.join(root, "patches", patchFile),
    [
      `diff --git a/${file} b/${file}`,
      `--- a/${file}`,
      `+++ b/${file}`,
      "@@ -1 +1 @@",
      `-export const value = ${from};`,
      `+export const value = ${to};`,
      "",
    ].join("\n"),
  );
}

function install(root, PATH = `${bin}${path.delimiter}${process.env.PATH}`) {
  return spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH },
  });
}

test("a patch that changed since it was applied removes the package for a clean reinstall", () => {
  const { root, packageDir } = createCheckout();
  try {
    writePatch(root, 1, 2);
    assert.equal(install(root).status, 0);
    assert.equal(
      readFileSync(path.join(packageDir, "index.js"), "utf8"),
      "export const value = 2;\n",
    );

    writePatch(root, 1, 3);
    const result = install(root);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Run npm install again/);
    assert.equal(existsSync(packageDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an already applied patch leaves the package in place", () => {
  const { root, packageDir } = createCheckout();
  try {
    writePatch(root, 1, 2);
    assert.equal(install(root).status, 0);
    assert.equal(install(root).status, 0);
    assert.equal(
      readFileSync(path.join(packageDir, "index.js"), "utf8"),
      "export const value = 2;\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing patch-package fails the install and leaves the package in place", () => {
  const { root, packageDir } = createCheckout();
  try {
    writePatch(root, 1, 2);
    const result = install(root, root);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /failed to spawn/);
    assert.equal(existsSync(packageDir), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("jest-worker terminal retirement patch is delivered and reapplied idempotently", () => {
  const root = mkdtempSync(path.join(tmpdir(), "postinstall-jest-worker-"));
  const packageDir = path.join(root, "node_modules", "jest-worker");
  try {
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "checkout" }));
    cpSync(path.resolve("node_modules", "jest-worker"), packageDir, { recursive: true });
    mkdirSync(path.join(root, "patches"));
    copyFileSync(
      path.resolve("patches", "jest-worker+29.7.0.patch"),
      path.join(root, "patches", "jest-worker+29.7.0.patch"),
    );

    const first = install(root);
    assert.equal(first.status, 0, first.stderr);
    const workerPath = path.join(packageDir, "build", "workers", "NodeThreadsWorker.js");
    const patched = readFileSync(workerPath, "utf8");
    assert.equal(patched.match(/this\.state = _types\.WorkerStates\.SHUT_DOWN;/g)?.length, 2);
    assert.equal(
      JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8")).version,
      "29.7.0",
    );

    const repeated = install(root);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal(readFileSync(workerPath, "utf8"), patched);
    assert.equal(existsSync(packageDir), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("enriched-markdown UMD metadata patch is delivered and reapplied idempotently", () => {
  const root = mkdtempSync(path.join(tmpdir(), "postinstall-markdown-umd-"));
  const appDir = path.join(root, "packages", "app");
  const packageDir = path.join(appDir, "node_modules", "react-native-enriched-markdown");
  const patchName = "react-native-enriched-markdown+1.2.0-nightly-20261014-766fc0e67.patch";
  try {
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "checkout" }));
    mkdirSync(appDir, { recursive: true });
    writeFileSync(path.join(appDir, "package.json"), JSON.stringify({ name: "fixture-app" }));
    cpSync(path.resolve("packages/app/node_modules/react-native-enriched-markdown"), packageDir, {
      recursive: true,
    });
    mkdirSync(path.join(root, "patches"));
    copyFileSync(path.resolve("patches", patchName), path.join(root, "patches", patchName));

    const metadataPath = path.join(packageDir, "lib", "module", "web", "wasm", "package.json");
    const parentMetadataPath = path.join(packageDir, "lib", "module", "package.json");
    const parentMetadata = readFileSync(parentMetadataPath, "utf8");
    const version = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8")).version;
    assert.equal(version, "1.2.0-nightly-20261014-766fc0e67");
    assert.equal(JSON.parse(parentMetadata).type, "module");
    const factories = ["lib/module/web/wasm/md4c.js", "src/web/wasm/md4c.js"].map((file) => ({
      file: path.join(packageDir, file),
      bytes: readFileSync(path.join(packageDir, file)),
    }));

    // A previously installed copy may lack only this new metadata file. Complete
    // the private target before reversing the entire selected patch to pristine.
    if (!existsSync(metadataPath)) {
      writeFileSync(metadataPath, '{\n  "type": "commonjs"\n}\n');
    }
    assert.deepEqual(JSON.parse(readFileSync(metadataPath, "utf8")), { type: "commonjs" });

    const isWindows = process.platform === "win32";
    const reverse = spawnSync(
      isWindows ? "patch-package.cmd" : "patch-package",
      [
        "--reverse",
        "--patch-dir",
        path.relative(appDir, path.join(root, "patches")),
        "--error-on-fail",
      ],
      {
        cwd: appDir,
        encoding: "utf8",
        shell: isWindows,
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
      },
    );
    assert.equal(reverse.status, 0, reverse.stderr || reverse.stdout);
    assert.equal(
      existsSync(metadataPath),
      false,
      "full patch reversal must remove the added WASM package scope",
    );

    /** Check real delivery without changing the parser or either Metro UMD factory. */
    function assertPatchedPackage() {
      assert.deepEqual(JSON.parse(readFileSync(metadataPath, "utf8")), { type: "commonjs" });
      assert.equal(readFileSync(parentMetadataPath, "utf8"), parentMetadata);
      assert.equal(JSON.parse(readFileSync(parentMetadataPath, "utf8")).type, "module");
      assert.equal(
        JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8")).version,
        version,
      );
      for (const factory of factories) {
        assert.deepEqual(readFileSync(factory.file), factory.bytes);
      }
    }

    const first = install(root);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    assertPatchedPackage();

    const repeated = install(root);
    assert.equal(repeated.status, 0, repeated.stderr || repeated.stdout);
    assertPatchedPackage();
    assert.equal(existsSync(packageDir), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
