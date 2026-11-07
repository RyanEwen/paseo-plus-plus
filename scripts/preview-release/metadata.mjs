import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isMainModule } from "../is-main-module.mjs";

const require = createRequire(import.meta.url);
const { getPreviewReleaseVersion } = require("../../packages/app/native-release-version.js");

/** Resolve one release identity from a fixed commit and the workflow's durable run number. */
export function resolvePreviewRelease({ upstreamVersion, buildNumber, commit }) {
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error("Preview source must be a full Git commit SHA");
  }
  const { version, appVersion, androidVersionCode } = getPreviewReleaseVersion(
    upstreamVersion,
    buildNumber,
  );

  return {
    version,
    upstreamVersion,
    appVersion,
    buildNumber,
    androidVersionCode,
    tag: `v${version}`,
    commit,
  };
}

/** Write a release identity as the pretty-printed `preview-release.json` other jobs read. */
export function writePreviewRelease(file, release) {
  writeFileSync(file, `${JSON.stringify(release, null, 2)}\n`);
}

/** Print the release outputs a workflow step appends to `$GITHUB_OUTPUT`. */
export function printReleaseOutputs(release, write = (text) => process.stdout.write(text)) {
  for (const name of ["version", "tag", "commit"]) {
    write(`${name}=${release[name]}\n`);
  }
}

/**
 * Stamp a checkout's root manifest with a preview version and sync every workspace to it.
 *
 * The desktop compares the running daemon version with its own version, so every bundled
 * workspace must carry the same version or an owned daemon is restarted as perpetually outdated.
 * The sync runs the checkout's own upstream scripts/sync-workspace-versions.mjs, which always
 * operates on the checkout that contains it.
 */
export function stampCheckoutVersion({ root, version }) {
  const manifestPath = path.join(root, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.version = version;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  execFileSync(process.execPath, [path.join(root, "scripts/sync-workspace-versions.mjs")], {
    stdio: "inherit",
  });
}

if (isMainModule(import.meta.url)) {
  const upstreamVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
  const release = resolvePreviewRelease({
    upstreamVersion,
    buildNumber: Number(process.env.PASEO_PREVIEW_BUILD_NUMBER),
    commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  });
  writePreviewRelease("preview-release.json", release);
  printReleaseOutputs(release);
}
