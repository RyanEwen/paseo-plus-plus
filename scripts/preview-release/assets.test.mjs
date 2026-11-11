import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { dump, load } from "js-yaml";
import { assemblePreviewAssets, validatePreviewAssets } from "./assets.mjs";
import { resolvePreviewRelease } from "./metadata.mjs";

const releaseDate = "2026-09-04T00:00:00.000Z";

/** Build real tiny files and matching manifests without invoking packaging or network services. */
async function withPreviewBuilds(run) {
  const root = mkdtempSync(path.join(tmpdir(), "paseo-preview-assets-"));
  const release = resolvePreviewRelease({
    upstreamVersion: "0.11.0-beta.5",
    buildNumber: 12,
    commit: "a".repeat(40),
  });
  const targets = [
    ["windows", "x64", ["exe", "zip"], "preview.yml"],
    ["windows", "arm64", ["exe", "zip"], "preview.yml"],
    ["linux", "x64", ["AppImage", "deb", "rpm", "tar.gz"], "preview-linux.yml"],
    ["linux", "arm64", ["AppImage", "deb", "rpm", "tar.gz"], "preview-linux-arm64.yml"],
  ];
  const input = path.join(root, "input");
  const output = path.join(root, "output");
  try {
    for (const [os, arch, extensions, manifestName] of targets) {
      const folder = path.join(input, `preview-${os}-${arch}`);
      mkdirSync(folder, { recursive: true });
      const files = [];
      for (const extension of extensions) {
        // Use the filenames emitted by real electron-builder jobs, rather than generic arch labels.
        const linuxArchitectures = {
          x64: { AppImage: "x86_64", deb: "amd64", rpm: "x86_64" },
          arm64: { rpm: "aarch64" },
        };
        const artifactArch = os === "linux" ? (linuxArchitectures[arch][extension] ?? arch) : arch;
        const version = extension === "AppImage" ? "" : `${release.version}-`;
        const url = `Paseo-Plus-Plus-${version}${artifactArch}.${extension}`;
        const bytes = Buffer.from(`${os}-${arch}-${extension}`);
        writeFileSync(path.join(folder, url), bytes);
        files.push({ url, sha512: createHash("sha512").update(bytes).digest("base64") });
      }
      writeFileSync(path.join(folder, "preview-release.json"), JSON.stringify(release));
      writeFileSync(path.join(folder, manifestName), dump({ version: release.version, files }));
    }
    for (const target of ["linux-x64", "linux-arm64"]) {
      const folder = path.join(input, `preview-daemon-${target}`);
      mkdirSync(folder, { recursive: true });
      writeFileSync(path.join(folder, "preview-release.json"), JSON.stringify(release));
      writeFileSync(
        path.join(folder, `paseo-daemon-${release.version}-${target}.tgz`),
        "daemon-fixture",
      );
    }
    const android = path.join(input, "preview-android");
    mkdirSync(android);
    writeFileSync(path.join(android, "preview-release.json"), JSON.stringify(release));
    writeFileSync(
      path.join(android, `Paseo-Plus-Plus-${release.version}-android.apk`),
      "signed-apk-fixture",
    );
    await run({ root, input, output, release });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("assembles both Windows architectures and distinct Linux update channels with complete checksums", async () => {
  await withPreviewBuilds(async (fixture) => {
    await assemblePreviewAssets({ ...fixture, releaseDate });
    const windows = load(readFileSync(path.join(fixture.output, "preview.yml"), "utf8"));
    assert.deepEqual(
      windows.files.map((file) => file.url),
      [
        "Paseo-Plus-Plus-0.11.0-preview.12-x64.exe",
        "Paseo-Plus-Plus-0.11.0-preview.12-x64.zip",
        "Paseo-Plus-Plus-0.11.0-preview.12-arm64.exe",
        "Paseo-Plus-Plus-0.11.0-preview.12-arm64.zip",
      ],
    );
    assert.equal(windows.releaseDate, releaseDate);
    assert.equal(windows.rolloutHours, 0);
    const names = readdirSync(fixture.output);
    assert.deepEqual(names.filter((name) => name.startsWith("paseo-daemon-")).sort(), [
      "paseo-daemon-0.11.0-preview.12-linux-arm64.tgz",
      "paseo-daemon-0.11.0-preview.12-linux-x64.tgz",
    ]);
    assert.ok(names.includes("preview-linux-arm64.yml"));
    for (const name of [
      "Paseo-Plus-Plus-x86_64.AppImage",
      "Paseo-Plus-Plus-0.11.0-preview.12-amd64.deb",
      "Paseo-Plus-Plus-0.11.0-preview.12-x86_64.rpm",
      "Paseo-Plus-Plus-0.11.0-preview.12-aarch64.rpm",
    ]) {
      assert.ok(names.includes(name), `Missing native Linux package: ${name}`);
    }
    assert.equal(
      readFileSync(path.join(fixture.output, "SHA256SUMS"), "utf8").trim().split("\n").length,
      names.length - 1,
    );
    await validatePreviewAssets({ directory: fixture.output, release: fixture.release });
    writeFileSync(
      path.join(fixture.output, "Paseo-Plus-Plus-0.11.0-preview.12-android.apk"),
      "changed-bytes",
    );
    await assert.rejects(
      validatePreviewAssets({ directory: fixture.output, release: fixture.release }),
      /checksum mismatch/,
    );
  });
});

test("refuses a missing architecture, a mixed source commit, and a corrupt updater binary", async () => {
  await withPreviewBuilds(async (fixture) => {
    const folder = path.join(fixture.input, "preview-linux-arm64");
    const appImage = path.join(folder, "Paseo-Plus-Plus-arm64.AppImage");
    rmSync(appImage);
    await assert.rejects(assemblePreviewAssets(fixture), /expected one arm64 AppImage/);
    rmSync(fixture.output, { recursive: true, force: true });
    writeFileSync(appImage, "linux-arm64-AppImage");
    writeFileSync(
      path.join(folder, "preview-release.json"),
      JSON.stringify({ ...fixture.release, commit: "b".repeat(40) }),
    );
    await assert.rejects(assemblePreviewAssets(fixture), /mismatched release commit/);
    rmSync(fixture.output, { recursive: true, force: true });
    writeFileSync(path.join(folder, "preview-release.json"), JSON.stringify(fixture.release));
    writeFileSync(appImage, "corrupt-bytes");
    await assert.rejects(assemblePreviewAssets(fixture), /updater hash mismatch/);
  });
});

test("a missing or mixed-source daemon build prevents preview assembly", async () => {
  await withPreviewBuilds(async (fixture) => {
    rmSync(
      path.join(
        fixture.input,
        "preview-daemon-linux-arm64",
        `paseo-daemon-${fixture.release.version}-linux-arm64.tgz`,
      ),
    );
    await assert.rejects(assemblePreviewAssets(fixture), /ENOENT/);
  });
  await withPreviewBuilds(async (fixture) => {
    writeFileSync(
      path.join(fixture.input, "preview-daemon-linux-x64", "preview-release.json"),
      JSON.stringify({ ...fixture.release, commit: "b".repeat(40) }),
    );
    await assert.rejects(assemblePreviewAssets(fixture), /mismatched release commit/);
  });
});
