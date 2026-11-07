import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  printReleaseOutputs,
  resolvePreviewRelease,
  stampCheckoutVersion,
  writePreviewRelease,
} from "./metadata.mjs";

const commit = "a".repeat(40);

test("fork previews have distinct release identities tied to one full commit", () => {
  assert.deepEqual(
    resolvePreviewRelease({ upstreamVersion: "0.11.0-beta.5", buildNumber: 12, commit }),
    {
      version: "0.11.0-preview.12",
      upstreamVersion: "0.11.0-beta.5",
      appVersion: "0.11.0",
      buildNumber: 12,
      androidVersionCode: 1_000_000_012,
      tag: "v0.11.0-preview.12",
      commit,
    },
  );
  assert.throws(
    () => resolvePreviewRelease({ upstreamVersion: "0.11.0", buildNumber: 12, commit: "main" }),
    /full Git commit/,
  );
});

test("writes the release file pretty-printed with a trailing newline", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "paseo-preview-release-file-"));
  try {
    const file = path.join(directory, "preview-release.json");
    const release = { version: "0.11.0-preview.12", tag: "v0.11.0-preview.12", commit };
    writePreviewRelease(file, release);
    assert.equal(readFileSync(file, "utf8"), `${JSON.stringify(release, null, 2)}\n`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("prints only the version, tag and commit workflow outputs", () => {
  const lines = [];
  printReleaseOutputs(
    { version: "0.11.0-preview.12", tag: "v0.11.0-preview.12", commit, buildNumber: 12 },
    (text) => lines.push(text),
  );
  assert.deepEqual(lines, [
    "version=0.11.0-preview.12\n",
    "tag=v0.11.0-preview.12\n",
    `commit=${commit}\n`,
  ]);
});

test("stamps the root and every workspace with the preview version", () => {
  const root = mkdtempSync(path.join(tmpdir(), "paseo-preview-stamp-"));
  try {
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ version: "0.11.0-beta.5", workspaces: ["packages/server", "packages/cli"] }),
    );
    // The stamp runs the checkout's own upstream sync script.
    mkdirSync(path.join(root, "scripts"));
    copyFileSync(
      new URL("../sync-workspace-versions.mjs", import.meta.url),
      path.join(root, "scripts/sync-workspace-versions.mjs"),
    );
    for (const name of ["server", "cli"]) {
      mkdirSync(path.join(root, "packages", name), { recursive: true });
      writeFileSync(
        path.join(root, "packages", name, "package.json"),
        JSON.stringify({
          name: `@getpaseo/${name}`,
          version: "0.11.0-beta.5",
          dependencies: name === "cli" ? { "@getpaseo/server": "0.11.0-beta.5" } : {},
        }),
      );
    }

    stampCheckoutVersion({ root, version: "0.11.0-preview.12" });

    const rootText = readFileSync(path.join(root, "package.json"), "utf8");
    assert.equal(JSON.parse(rootText).version, "0.11.0-preview.12");
    assert.ok(rootText.endsWith("}\n"));
    const cli = JSON.parse(readFileSync(path.join(root, "packages/cli/package.json"), "utf8"));
    assert.equal(cli.version, "0.11.0-preview.12");
    assert.equal(cli.dependencies["@getpaseo/server"], "0.11.0-preview.12");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
