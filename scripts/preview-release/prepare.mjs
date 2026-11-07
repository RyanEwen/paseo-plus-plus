import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dump, load } from "js-yaml";
import { isMainModule } from "../is-main-module.mjs";
import { resolvePreviewRelease, stampCheckoutVersion, writePreviewRelease } from "./metadata.mjs";
import { runNpm } from "./npm.mjs";

import { requireFromElectronBuilder } from "./packager.mjs";

const { getConfig } = requireFromElectronBuilder("app-builder-lib/out/util/config/config.js");

/**
 * Resolve the preview electron-builder config with inheritance already flattened.
 *
 * electron-builder concatenates target arrays across `extends`. Resolving inheritance first keeps a
 * native ARM64 job from silently queueing x64 targets inherited from the official config.
 * `buildVersion` is the four-slot Windows file version.
 */
async function resolvePreviewBuilderConfig({ root, buildVersion }) {
  const desktop = path.join(root, "packages/desktop");
  const builderConfig = await getConfig(desktop, "electron-builder.preview.yml", null);
  delete builderConfig.extends;

  const previewConfig = load(
    readFileSync(path.join(desktop, "electron-builder.preview.yml"), "utf8"),
  );
  // These arrays replace official registrations and launcher arguments rather than combining them.
  builderConfig.protocols = previewConfig.protocols;
  builderConfig.appImage.executableArgs = previewConfig.appImage.executableArgs;
  builderConfig.buildVersion = buildVersion;
  return builderConfig;
}

/**
 * Require Azure Trusted Signing and limit Windows targets to this job's architecture.
 * Mutates `builderConfig`. Throws when a signing field is missing or the architecture is unsupported.
 */
function applyWindowsSigning(builderConfig, { arch, signingEnv }) {
  const signingFields = {
    publisherName: signingEnv.PASEO_AZURE_PUBLISHER_NAME,
    endpoint: signingEnv.PASEO_AZURE_SIGNING_ENDPOINT,
    certificateProfileName: signingEnv.PASEO_AZURE_CERTIFICATE_PROFILE,
    codeSigningAccountName: signingEnv.PASEO_AZURE_SIGNING_ACCOUNT,
  };
  for (const [field, value] of Object.entries(signingFields)) {
    if (!value?.trim()) {
      throw new Error(`Missing Azure Trusted Signing configuration: ${field}`);
    }
  }

  builderConfig.forceCodeSigning = true;
  if (arch !== "x64" && arch !== "arm64") {
    throw new Error(`Unsupported preview Windows architecture: ${arch}`);
  }
  builderConfig.win = {
    ...builderConfig.win,
    azureSignOptions: signingFields,
    target: [
      { target: "nsis", arch: [arch] },
      { target: "zip", arch: [arch] },
    ],
  };
}

/** Prepare version and packaging inputs in a disposable checkout, leaving npm releases untouched. */
export async function preparePreviewBuild({
  root,
  buildNumber,
  commit,
  platform = process.platform,
  arch = process.arch,
  signingEnv = process.env,
}) {
  const rootPackage = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const release = resolvePreviewRelease({
    upstreamVersion: rootPackage.version,
    buildNumber,
    commit,
  });
  // Windows PE versions have four numeric slots; do not send a descriptive prerelease to rcedit.
  if (buildNumber > 65_535) {
    throw new Error("Preview build number exceeds the Windows PE version slot");
  }

  const builderConfig = await resolvePreviewBuilderConfig({
    root,
    buildVersion: `${release.appVersion}.${buildNumber}`,
  });
  if (platform === "win32") {
    applyWindowsSigning(builderConfig, { arch, signingEnv });
  }

  stampCheckoutVersion({ root, version: release.version });
  writeFileSync(
    path.join(root, "packages/desktop/electron-builder.preview.local.yml"),
    dump(builderConfig),
  );
  writePreviewRelease(path.join(root, "preview-release.json"), release);
  return release;
}

if (isMainModule(import.meta.url)) {
  await preparePreviewBuild({
    root: process.cwd(),
    buildNumber: Number(process.env.PASEO_PREVIEW_BUILD_NUMBER),
    commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  });
  // Refresh only lock metadata after changing workspace versions; installed external
  // dependency versions stay pinned and no lifecycle hooks run in this build checkout.
  runNpm(
    [
      "install",
      "--package-lock-only",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--workspaces",
      "--include-workspace-root",
    ],
    { stdio: "inherit" },
  );
}
