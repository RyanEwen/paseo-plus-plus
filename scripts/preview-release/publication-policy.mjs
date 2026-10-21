import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isMainModule } from "../is-main-module.mjs";
import { requirePreviewRepository } from "./source.mjs";

export const updaterBridgeMarker = "<!-- paseo-plus-plus-updater-bridge:v1 -->";

/** Parse the retained tag namespace without allowing an unsafe or reset native build counter. */
function releaseIdentity(tag) {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-preview\.([1-9]\d*)$/.exec(tag);
  const build = Number(match?.[4]);
  if (!match || !Number.isSafeInteger(build) || build > 1_100_000_000) {
    throw new Error("Expected a canonical fork workflow tag and valid build number");
  }
  return { core: match.slice(1, 4).map((part) => BigInt(part)), build };
}

/** Pin the complete qualified asset inventory, including identities, sizes and GitHub digests. */
export function fingerprintBridgeAssets(assets) {
  if (!Array.isArray(assets) || assets.length === 0) {
    throw new Error("Qualified bridge assets are missing");
  }
  const names = new Set();
  const ids = new Set();
  const inventory = assets.map(({ id, name, size, digest, state }) => {
    if (
      !Number.isSafeInteger(id) ||
      id < 1 ||
      ids.has(id) ||
      typeof name !== "string" ||
      !name ||
      names.has(name) ||
      !Number.isSafeInteger(size) ||
      size < 1 ||
      !/^sha256:[a-f0-9]{64}$/.test(digest) ||
      state !== "uploaded"
    ) {
      throw new Error("Qualified bridge asset inventory is invalid or ambiguous");
    }
    names.add(name);
    ids.add(id);
    return { id, name, size, digest };
  });
  inventory.sort((left, right) => {
    if (left.name < right.name) return -1;
    if (left.name > right.name) return 1;
    return 0;
  });
  return createHash("sha256").update(JSON.stringify(inventory)).digest("hex");
}

/** Validate a reviewed receipt before treating its fields as API or evidence-file identifiers. */
function requireQualifiedBridge(qualifiedBridge) {
  if (
    !qualifiedBridge ||
    qualifiedBridge.schemaVersion !== 1 ||
    !Number.isSafeInteger(qualifiedBridge.releaseId) ||
    qualifiedBridge.releaseId < 1 ||
    !/^[a-f0-9]{40}$/.test(qualifiedBridge.commit) ||
    !/^[a-f0-9]{64}$/.test(qualifiedBridge.assetFingerprint) ||
    !/^docs\/qa-evidence\/(?!.*\.\.)[A-Za-z0-9_./-]+\.md$/.test(
      qualifiedBridge.qualificationEvidence,
    )
  ) {
    throw new Error("Normal Latest releases require a reviewed qualified-bridge receipt");
  }
  return releaseIdentity(qualifiedBridge.tag);
}

/** Advance both Android's workflow counter and desktop's semver core without allowing rollback. */
function requireNewerBuild(current, previous) {
  const firstDifferentCore = current.core.findIndex((part, index) => part !== previous.core[index]);
  if (
    current.build <= previous.build ||
    (firstDifferentCore !== -1 &&
      current.core[firstDifferentCore] < previous.core[firstDifferentCore])
  ) {
    throw new Error(
      "Fork releases must advance the published workflow counter and desktop version",
    );
  }
}

/** Require the exact published prerelease and pinned assets before admitting normal releases. */
function requireRetainedBridge(retainedBridge, releases) {
  if (
    !retainedBridge ||
    !Number.isSafeInteger(retainedBridge.releaseId) ||
    retainedBridge.releaseId < 1 ||
    !/^[a-f0-9]{40}$/.test(retainedBridge.commit) ||
    !/^[a-f0-9]{64}$/.test(retainedBridge.assetFingerprint)
  ) {
    throw new Error("Preview releases require source-controlled bridge retention evidence");
  }
  const identity = releaseIdentity(retainedBridge.tag);
  const matches = releases.filter((candidate) => candidate.tag_name === retainedBridge.tag);
  const bridge = matches[0];
  if (
    matches.length !== 1 ||
    bridge.id !== retainedBridge.releaseId ||
    bridge.draft !== false ||
    bridge.prerelease !== true ||
    bridge.target_commitish !== retainedBridge.commit ||
    !bridge.body?.includes(updaterBridgeMarker) ||
    fingerprintBridgeAssets(bridge.assets) !== retainedBridge.assetFingerprint
  ) {
    throw new Error(
      "The exact qualified prerelease bridge and its immutable assets must remain published",
    );
  }
  return identity;
}

/**
 * Resolve GitHub classification from reviewed bridge evidence and fresh read-only API results.
 * A receipt attests real updater qualification; release metadata alone cannot establish that.
 */
export function resolvePublicationPolicy({
  kind,
  release,
  qualifiedBridge,
  retainedBridge,
  releases,
  comparison,
}) {
  if (!["bridge", "preview", "latest"].includes(kind)) {
    throw new Error("Release kind must be bridge, preview or latest");
  }
  const current = releaseIdentity(release.tag);
  if (
    release.version !== release.tag.slice(1) ||
    current.build !== release.buildNumber ||
    !/^[a-f0-9]{40}$/.test(release.commit)
  ) {
    throw new Error("Release provenance does not match its canonical tag");
  }
  for (const published of releases) {
    if (!published.draft && /^v\d+\.\d+\.\d+-preview\.\d+$/.test(published.tag_name)) {
      requireNewerBuild(current, releaseIdentity(published.tag_name));
    }
  }
  if (kind === "bridge") {
    if (
      qualifiedBridge !== null ||
      releases.some(
        (candidate) => !candidate.draft && candidate.body?.includes(updaterBridgeMarker),
      )
    ) {
      throw new Error(
        "The final updater bridge already exists; retain it and use latest after qualification",
      );
    }
    return { prerelease: true, makeLatest: false };
  }

  // Retention permits continued prereleases; only installed-updater evidence permits Latest.
  if (kind === "latest") requireQualifiedBridge(qualifiedBridge);
  const expectedBridge = kind === "preview" ? retainedBridge : qualifiedBridge;
  const identity = requireRetainedBridge(expectedBridge, releases);
  requireNewerBuild(current, identity);
  if (
    comparison?.status !== "ahead" ||
    comparison.base_commit?.sha !== expectedBridge.commit ||
    comparison.merge_base_commit?.sha !== expectedBridge.commit
  ) {
    throw new Error("Release source must descend from the retained bridge source");
  }
  return kind === "preview"
    ? { prerelease: true, makeLatest: false }
    : { prerelease: false, makeLatest: true };
}

/** Pin availability from captured public API/provenance, without claiming installed-updater qualification. */
function readBridgeRetention() {
  const retained = JSON.parse(
    readFileSync(
      new URL("../../docs/qa-evidence/updater-bridge/release32-api.json", import.meta.url),
      "utf8",
    ),
  );
  const source = JSON.parse(
    readFileSync(
      new URL("../../docs/qa-evidence/updater-bridge/preview-release.json", import.meta.url),
      "utf8",
    ),
  );
  const identity = releaseIdentity(source.tag);
  if (
    retained.tag_name !== source.tag ||
    retained.target_commitish !== source.commit ||
    source.version !== source.tag.slice(1) ||
    source.buildNumber !== identity.build
  ) {
    throw new Error("Retained bridge API inventory and canonical provenance disagree");
  }
  const evidence = {
    releaseId: retained.id,
    tag: source.tag,
    commit: source.commit,
    assetFingerprint: fingerprintBridgeAssets(retained.assets),
  };
  requireRetainedBridge(evidence, [retained]);
  return evidence;
}

/** Read bounded JSON with gh's existing authentication, without performing a GitHub mutation. */
function readGitHubJson(args) {
  return JSON.parse(
    execFileSync("gh", ["api", ...args], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60_000,
    }),
  );
}

/** Recheck bridge availability before builds, draft changes and the final publish operation. */
export function requirePublicationPolicy({ kind, repo, release }) {
  requirePreviewRepository(repo);
  const qualifiedBridge = JSON.parse(
    readFileSync(new URL("./qualified-bridge.json", import.meta.url), "utf8"),
  );
  // Validate the local choice before API access; no input or environment variable can supply a receipt.
  if (!["bridge", "preview", "latest"].includes(kind))
    throw new Error("Release kind must be bridge, preview or latest");
  if (kind === "latest" && !qualifiedBridge) {
    throw new Error("Normal Latest releases require a reviewed qualified-bridge receipt");
  }
  // Reject malformed receipt paths and commits before using them in a URL or filesystem lookup.
  if (kind === "latest") {
    requireQualifiedBridge(qualifiedBridge);
  }
  const retainedBridge = kind === "preview" ? readBridgeRetention() : null;
  const releases = readGitHubJson([
    `repos/${repo}/releases?per_page=100`,
    "--paginate",
    "--slurp",
  ]).flat();
  const comparison =
    kind !== "bridge"
      ? readGitHubJson([
          `repos/${repo}/compare/${(kind === "preview" ? retainedBridge : qualifiedBridge).commit}...${release.commit}`,
        ])
      : null;
  const policy = resolvePublicationPolicy({
    kind,
    release,
    qualifiedBridge,
    retainedBridge,
    releases,
    comparison,
  });
  if (
    kind === "latest" &&
    !existsSync(new URL(`../../${qualifiedBridge.qualificationEvidence}`, import.meta.url))
  ) {
    throw new Error("The reviewed bridge qualification evidence is missing from this source");
  }
  return policy;
}

if (isMainModule(import.meta.url)) {
  requirePublicationPolicy({
    kind: process.env.PASEO_PREVIEW_RELEASE_KIND ?? "preview",
    repo: process.env.GITHUB_REPOSITORY,
    release: JSON.parse(readFileSync("preview-release.json", "utf8")),
  });
}
