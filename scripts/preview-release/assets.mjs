import { createHash } from "node:crypto";
import {
  createReadStream,
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { dump, load } from "js-yaml";
import { isMainModule } from "../is-main-module.mjs";
import { writePreviewRelease } from "./metadata.mjs";
import { requireFromElectronBuilder } from "./packager.mjs";

const { archFromString, getArtifactArchName } = requireFromElectronBuilder("builder-util");

/** Match the packager's native architecture names, including amd64 and x86_64 Linux assets. */
function assetSuffix(arch, extension) {
  return `-${getArtifactArchName(archFromString(arch), extension)}.${extension}`;
}

const daemonTargets = ["linux-x64", "linux-arm64"];

/**
 * Desktop builds the release requires. `manifest` is the updater channel file the target writes;
 * targets that share one (both Windows architectures) are merged in this order. `updater` is the
 * installer extension that channel must list for the target's architecture.
 */
const desktopTargets = [
  {
    folder: "preview-windows-x64",
    arch: "x64",
    extensions: ["exe", "zip"],
    manifest: "preview.yml",
    updater: "exe",
  },
  {
    folder: "preview-windows-arm64",
    arch: "arm64",
    extensions: ["exe", "zip"],
    manifest: "preview.yml",
    updater: "exe",
  },
  {
    folder: "preview-linux-x64",
    arch: "x64",
    extensions: ["AppImage", "deb", "rpm", "tar.gz"],
    manifest: "preview-linux.yml",
    updater: "AppImage",
  },
  {
    folder: "preview-linux-arm64",
    arch: "arm64",
    extensions: ["AppImage", "deb", "rpm", "tar.gz"],
    manifest: "preview-linux-arm64.yml",
    updater: "AppImage",
  },
];

/** Hash files as streams; a multi-platform release can contain several gigabytes. */
async function hashFile(file, algorithm, encoding) {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest(encoding);
}

/** Reject mixed source commits, absent platforms, and manifests pointing at the wrong binary. */
function readBuildRelease(folder, expected) {
  const release = JSON.parse(readFileSync(path.join(folder, "preview-release.json"), "utf8"));
  for (const field of ["version", "tag", "commit", "androidVersionCode", "buildNumber"]) {
    if (release[field] !== expected[field]) {
      throw new Error(`${folder}: mismatched release ${field}`);
    }
  }
}

/** Copy one validated asset, refusing collisions between architecture builds. */
function copyAsset(source, output) {
  const name = path.basename(source);
  if (readdirSync(output).includes(name)) {
    throw new Error(`Duplicate release asset: ${name}`);
  }
  copyFileSync(source, path.join(output, name));
}

/** Validate updater hashes against uploaded bytes before making an update discoverable. */
async function validateManifest(manifest, folder, release) {
  if (
    manifest?.version !== release.version ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0
  ) {
    throw new Error(`${folder}: missing updater files or wrong version`);
  }
  for (const file of manifest.files) {
    if (
      typeof file.url !== "string" ||
      path.basename(file.url) !== file.url ||
      file.url.includes("\\")
    ) {
      throw new Error(`${folder}: unsafe updater asset path`);
    }
    const actualHash = await hashFile(path.join(folder, file.url), "sha512", "base64");
    if (file.sha512 !== actualHash) {
      throw new Error(`${folder}: updater hash mismatch for ${file.url}`);
    }
  }
}

/**
 * Validate one desktop build, copy its release assets and return its updater manifest stamped with
 * the release date. Throws on a mixed source, a missing or duplicated asset, or a manifest that
 * does not list the target's own installer.
 */
async function collectDesktopTarget({ target, input, output, release, releaseDate }) {
  const folder = path.join(input, target.folder);
  readBuildRelease(folder, release);
  const names = readdirSync(folder);
  for (const extension of target.extensions) {
    const candidates = names.filter((name) => name.endsWith(assetSuffix(target.arch, extension)));
    if (candidates.length !== 1) {
      throw new Error(`${target.folder}: expected one ${target.arch} ${extension} asset`);
    }
  }

  const manifest = load(readFileSync(path.join(folder, target.manifest), "utf8"));
  await validateManifest(manifest, folder, release);
  // Each OS/architecture manifest must include the actual installer it will select.
  const updaterSuffix = assetSuffix(target.arch, target.updater);
  if (!manifest.files.some((file) => file.url.endsWith(updaterSuffix))) {
    throw new Error(`${target.folder}: missing updater installer for ${target.arch}`);
  }

  for (const name of names) {
    const isReleaseAsset = /\.(exe|zip|AppImage|deb|rpm|tar\.gz|blockmap)$/.test(name);
    if (isReleaseAsset) {
      copyAsset(path.join(folder, name), output);
    }
  }
  return { ...manifest, releaseDate, rolloutHours: 0 };
}

/** Validate and copy one standalone daemon package. */
function collectDaemonTarget({ target, input, output, release }) {
  const folder = path.join(input, `preview-daemon-${target}`);
  readBuildRelease(folder, release);
  copyAsset(path.join(folder, `paseo-daemon-${release.version}-${target}.tgz`), output);
}

/** Validate and copy the single signed Android APK. */
function collectAndroidApk({ input, output, release }) {
  const folder = path.join(input, "preview-android");
  readBuildRelease(folder, release);
  const apks = readdirSync(folder).filter((name) => name.endsWith(".apk"));
  if (apks.length !== 1) {
    throw new Error("Expected one signed Android APK");
  }
  copyAsset(path.join(folder, apks[0]), output);
}

/**
 * Add a target's manifest to its channel file. Windows architectures share one channel file, so
 * their file lists are concatenated in target order; Linux updater filenames include the
 * architecture and stay separate.
 */
function addUpdateManifest(manifestsByFile, file, manifest) {
  const existing = manifestsByFile.get(file);
  manifestsByFile.set(
    file,
    existing ? { ...existing, files: [...existing.files, ...manifest.files] } : manifest,
  );
}

/** Write every updater channel file. */
function writeUpdateManifests(output, manifestsByFile) {
  for (const [file, manifest] of manifestsByFile) {
    writeFileSync(path.join(output, file), dump(manifest));
  }
}

/** Write SHA256SUMS for every file currently in `output`, sorted by name. */
async function writeChecksums(output) {
  const checksumLines = [];
  for (const name of readdirSync(output).sort()) {
    const digest = await hashFile(path.join(output, name), "sha256", "hex");
    checksumLines.push(`${digest}  ${name}`);
  }
  writeFileSync(path.join(output, "SHA256SUMS"), `${checksumLines.join("\n")}\n`);
}

/** Assemble all approved platforms and updater channels, then emit downloadable checksums. */
export async function assemblePreviewAssets({
  input,
  output,
  release,
  releaseDate = new Date().toISOString(),
}) {
  mkdirSync(output, { recursive: true });
  if (readdirSync(output).length !== 0) {
    throw new Error("Preview release output must be empty");
  }

  const manifestsByFile = new Map();
  for (const target of desktopTargets) {
    const manifest = await collectDesktopTarget({ target, input, output, release, releaseDate });
    addUpdateManifest(manifestsByFile, target.manifest, manifest);
  }
  for (const target of daemonTargets) {
    collectDaemonTarget({ target, input, output, release });
  }
  collectAndroidApk({ input, output, release });

  writeUpdateManifests(output, manifestsByFile);
  writePreviewRelease(path.join(output, "preview-release.json"), release);
  await writeChecksums(output);
  await validatePreviewAssets({ directory: output, release });
}

/** Revalidate the final asset set at the publishing boundary, including its checksum inventory. */
export async function validatePreviewAssets({ directory, release }) {
  const names = readdirSync(directory).sort();
  for (const target of desktopTargets) {
    for (const extension of target.extensions) {
      if (names.filter((name) => name.endsWith(assetSuffix(target.arch, extension))).length !== 1) {
        throw new Error(`Incomplete release: missing or duplicated ${target.arch} ${extension}`);
      }
    }
  }
  for (const target of daemonTargets) {
    const name = `paseo-daemon-${release.version}-${target}.tgz`;
    if (!names.includes(name)) throw new Error(`Incomplete release: missing daemon ${target}`);
  }
  if (names.filter((name) => name.endsWith(".apk")).length !== 1) {
    throw new Error("Incomplete release: expected one Android APK");
  }
  for (const name of ["preview.yml", "preview-linux.yml", "preview-linux-arm64.yml"]) {
    await validateManifest(
      load(readFileSync(path.join(directory, name), "utf8")),
      directory,
      release,
    );
  }
  const checksums = readFileSync(path.join(directory, "SHA256SUMS"), "utf8").trim().split("\n");
  const inventory = [];
  for (const line of checksums) {
    const match = /^([a-f0-9]{64})  ([^/\\]+)$/.exec(line);
    if (!match) {
      throw new Error("Invalid release checksum inventory");
    }
    const [, expectedHash, name] = match;
    const actualHash = await hashFile(path.join(directory, name), "sha256", "hex");
    if (actualHash !== expectedHash) {
      throw new Error(`Release checksum mismatch: ${name}`);
    }
    inventory.push(name);
  }
  const expectedInventory = names.filter((name) => name !== "SHA256SUMS");
  if (JSON.stringify(inventory.sort()) !== JSON.stringify(expectedInventory)) {
    throw new Error("Release checksum inventory does not match the complete asset set");
  }
}

if (isMainModule(import.meta.url)) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    throw new Error(
      "Usage: node scripts/preview-release/assets.mjs <downloaded-artifacts> <release-dir>",
    );
  }
  const release = JSON.parse(readFileSync("preview-release.json", "utf8"));
  await assemblePreviewAssets({ input, output, release });
}
