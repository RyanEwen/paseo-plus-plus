import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { validateAndroidBundlePlan, validateAndroidBundleResume } from "./android-bundle.mjs";

test("Android preview bundles retain release optimization and matching source maps", () => {
  const releasePlan = {
    dev: false,
    hermesEnabled: true,
    hermesFlags: ["-O", "-output-source-map"],
  };
  validateAndroidBundlePlan(releasePlan);
  for (const change of [
    { dev: true },
    { hermesEnabled: false },
    { hermesFlags: ["-Og", "-output-source-map"] },
    { hermesFlags: ["-O"] },
    { hermesFlags: ["-O", "-Og", "-output-source-map"] },
  ]) {
    assert.throws(
      () => validateAndroidBundlePlan({ ...releasePlan, ...change }),
      /Android previews/,
    );
  }
});

test("Android compiler resume requires the exact plan, both Metro inputs, maps, and compiler", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "paseo-android-resume-"));
  try {
    const assets = path.join(directory, "assets");
    const maps = path.join(directory, "maps");
    mkdirSync(assets);
    mkdirSync(maps);
    const bundle = path.join(assets, "index.android.bundle");
    const retained = path.join(directory, "compiler-input.js");
    const packagerMap = path.join(maps, "index.android.bundle.packager.map");
    const compiler = path.join(directory, "hermesc");
    writeFileSync(bundle, "exact Metro output");
    copyFileSync(bundle, retained);
    writeFileSync(packagerMap, "exact Metro source map");
    writeFileSync(compiler, "exact compiler identity");
    const plan = {
      dev: false,
      hermesEnabled: true,
      hermesFlags: ["-O", "-output-source-map"],
      assetName: "index.android.bundle",
      preparedDir: directory,
      hermesCommand: compiler,
    };
    const planSource = JSON.stringify(plan);
    const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
    const receipt = {
      planSHA256: digest(planSource),
      metroInputSHA256: digest(readFileSync(bundle)),
      packagerMapSHA256: digest(readFileSync(packagerMap)),
      hermesSHA256: digest(readFileSync(compiler)),
    };
    assert.deepEqual(validateAndroidBundleResume({ planSource, receipt }), plan);
    assert.throws(
      () => validateAndroidBundleResume({ planSource: `${planSource}\n`, receipt }),
      /plan checksum mismatch/,
    );
    for (const malformed of [undefined, null, [], {}, { ...receipt, planSHA256: "invalid" }]) {
      assert.throws(
        () => validateAndroidBundleResume({ planSource, receipt: malformed }),
        /resume requires/,
      );
    }
    for (const file of [bundle, retained, packagerMap, compiler]) {
      const original = readFileSync(file);
      writeFileSync(file, "stale or substituted input");
      assert.throws(
        () => validateAndroidBundleResume({ planSource, receipt }),
        /checksum mismatch/,
      );
      writeFileSync(file, original);
      rmSync(file);
      assert.throws(() => validateAndroidBundleResume({ planSource, receipt }), /ENOENT/);
      writeFileSync(file, original);
    }
    assert.equal(readFileSync(retained, "utf8"), "exact Metro output");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// This actual runner uses GNU time and Linux Hermes; checksum admission above stays portable.
test.skipIf(process.platform !== "linux")(
  "Android Metro-only CLI separates preparation from normal and resumed compilation",
  () => {
    const directory = mkdtempSync(path.join(tmpdir(), "paseo-android-metro-only-"));
    try {
      const driver = fileURLToPath(new URL("./android-bundle.mjs", import.meta.url));
      const metro = path.join(directory, "metro.mjs");
      const compiler = path.join(directory, "hermesc");
      const reactNative = path.join(directory, "react-native");
      const preparedDir = path.join(directory, "prepared");
      const digestFile = path.join(directory, "bundle-sha256.txt");
      const events = path.join(directory, "events.jsonl");
      mkdirSync(path.join(reactNative, "scripts"), { recursive: true });

      // Small executable fixtures exercise the actual CLI and subprocess boundaries.
      // They record orchestration without running Metro, Hermes, or a native build.
      writeFileSync(
        metro,
        `import fs from 'node:fs';
const argument = name => process.argv[process.argv.indexOf(name) + 1];
fs.appendFileSync('events.jsonl', 'Metro\\n');
fs.writeFileSync(argument('--bundle-output'), 'retained Metro JavaScript');
fs.writeFileSync(argument('--sourcemap-output'), '{"version":3}');
`,
      );
      writeFileSync(
        compiler,
        `#!${process.execPath}
const fs = require('node:fs');
const output = process.argv[process.argv.indexOf('-out') + 1];
fs.appendFileSync('events.jsonl', 'Hermes\\n');
fs.writeFileSync(output, Buffer.from('c61fbc03c103191f', 'hex'));
fs.writeFileSync(output + '.map', '{"version":3}');
`,
        { mode: 0o755 },
      );
      writeFileSync(
        path.join(reactNative, "scripts/compose-source-maps.js"),
        `const fs = require('node:fs');
fs.appendFileSync('events.jsonl', 'source maps\\n');
fs.writeFileSync(process.argv[process.argv.indexOf('-o') + 1], '{"version":3}');
`,
      );
      const plan = {
        root: directory,
        node: [process.execPath],
        cli: metro,
        command: "export:embed",
        entry: path.join(directory, "index.ts"),
        assetName: "index.android.bundle",
        config: null,
        extraArgs: [],
        dev: false,
        minify: false,
        hermesEnabled: true,
        hermesCommand: compiler,
        hermesFlags: ["-O", "-output-source-map"],
        reactNative,
        digestFile,
        preparedDir,
      };
      const planPath = path.join(directory, "plan.json");
      const planSource = JSON.stringify(plan);
      writeFileSync(planPath, planSource);
      const run = (...args) =>
        spawnSync(process.execPath, [driver, planPath, ...args], {
          encoding: "utf8",
          env: { ...process.env, GITHUB_ACTIONS: "false" },
          timeout: 15_000,
        });
      const bundle = path.join(preparedDir, "assets/index.android.bundle");
      const retained = path.join(preparedDir, "compiler-input.js");
      const packagerMap = path.join(preparedDir, "maps/index.android.bundle.packager.map");
      const phases = () => readFileSync(events, "utf8").trim().split("\n");

      const prepared = run("--metro-only");
      assert.equal(prepared.status, 0, prepared.stderr);
      assert.deepEqual(phases(), ["Metro"]);
      assert.equal(readFileSync(bundle, "utf8"), "retained Metro JavaScript");
      assert.equal(readFileSync(retained, "utf8"), "retained Metro JavaScript");
      assert.equal(existsSync(digestFile), false);
      const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
      const receiptPath = path.join(directory, "receipt.json");
      writeFileSync(
        receiptPath,
        JSON.stringify({
          planSHA256: digest(planSource),
          metroInputSHA256: digest(readFileSync(bundle)),
          packagerMapSHA256: digest(readFileSync(packagerMap)),
          hermesSHA256: digest(readFileSync(compiler)),
        }),
      );
      writeFileSync(events, "");
      const resumed = run("--resume-from-metro", receiptPath);
      assert.equal(resumed.status, 0, resumed.stderr);
      assert.deepEqual(phases(), ["Hermes", "source maps"]);
      assert.equal(readFileSync(retained, "utf8"), "retained Metro JavaScript");
      assert.equal(readFileSync(bundle).subarray(0, 8).toString("hex"), "c61fbc03c103191f");
      assert.equal(readFileSync(digestFile, "utf8").trim(), digest(readFileSync(bundle)));

      writeFileSync(events, "");
      const normal = run();
      assert.equal(normal.status, 0, normal.stderr);
      assert.deepEqual(phases(), ["Metro", "Hermes", "source maps"]);
      assert.equal(readFileSync(retained, "utf8"), "retained Metro JavaScript");

      // Release-plan rejection must happen before preparation removes any saved input.
      writeFileSync(planPath, JSON.stringify({ ...plan, dev: true }));
      writeFileSync(events, "");
      const rejected = run("--metro-only");
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /optimized release Hermes bytecode/);
      assert.equal(readFileSync(events, "utf8"), "");
      assert.equal(readFileSync(retained, "utf8"), "retained Metro JavaScript");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
