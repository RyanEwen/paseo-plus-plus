import { z } from "zod";

/**
 * Paseo++ release rules shared by daemon host updates and Android app updates. This module has
 * no platform dependencies, so both packages apply the same checks to the same GitHub releases.
 */

/** Discover releases through the current repository. */
export const FORK_RELEASE_REPOSITORY = "RyanEwen/paseo-plus-plus";

// COMPAT(fork-repo-rename): added in v0.11.2-preview, remove after the final prerelease updater
// bridge is retired (no calendar date; see docs/release.md, final prerelease bridge).
// Releases published before the rename keep canonical asset URLs under the legacy name.
const FORK_RELEASE_REPOSITORIES = [FORK_RELEASE_REPOSITORY, "RyanEwen/paseo"];

export const FORK_RELEASES_PER_PAGE = 100;

/** GitHub lists at most 1000 releases, so later pages are never needed. */
export const FORK_RELEASE_MAX_PAGES = 10;

const PREVIEW_TAG_PATTERN = /^v\d+\.\d+\.\d+-preview\.(\d+)$/;

// Android preview version codes are 1_000_000_000 + build and must stay within Google Play's
// 2_100_000_000 maximum, so a larger build number cannot be a real preview.
const MAX_PREVIEW_BUILD = 1_100_000_000;

export const ForkReleaseAssetSchema = z.object({
  name: z.string(),
  browser_download_url: z.string().url(),
});

export const ForkReleaseSchema = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  assets: z.array(ForkReleaseAssetSchema),
});

export const ForkReleasesSchema = z.array(ForkReleaseSchema);

export type ForkReleaseAsset = z.infer<typeof ForkReleaseAssetSchema>;
export type ForkRelease = z.infer<typeof ForkReleaseSchema>;

/** The GitHub API URL for one page of fork releases, counting from 1. */
export function buildForkReleasesPageUrl(page: number): string {
  return `https://api.github.com/repos/${FORK_RELEASE_REPOSITORY}/releases?per_page=${FORK_RELEASES_PER_PAGE}&page=${page}`;
}

/**
 * Read the workflow build number from a preview tag. Returns null for tags outside the preview
 * namespace and throws for a preview tag whose build number is out of range.
 */
export function parseForkPreviewBuild(tagName: string): number | null {
  const match = PREVIEW_TAG_PATTERN.exec(tagName);
  if (!match) return null;

  const build = Number(match[1]);
  if (!Number.isSafeInteger(build) || build < 1 || build > MAX_PREVIEW_BUILD) {
    throw new Error("Invalid preview build number");
  }
  return build;
}

/** Whether an asset's download URL is the exact GitHub URL for this tag in a fork repository. */
export function isCanonicalForkAssetUrl({
  asset,
  tagName,
}: {
  asset: ForkReleaseAsset;
  tagName: string;
}): boolean {
  return FORK_RELEASE_REPOSITORIES.some((repository) => {
    const expected = `https://github.com/${repository}/releases/download/${tagName}/${asset.name}`;
    return asset.browser_download_url === expected;
  });
}

/**
 * Read a file's digest from SHA256SUMS contents. Returns null unless exactly one line names the
 * file and that line is a lowercase SHA-256 followed by two spaces and the filename.
 */
export function readForkChecksum({
  checksums,
  filename,
}: {
  checksums: string;
  filename: string;
}): string | null {
  const suffix = `  ${filename}`;
  const entries = checksums.split("\n").filter((line) => line.endsWith(suffix));
  if (entries.length !== 1) return null;

  const digest = entries[0].slice(0, -suffix.length);
  return /^[a-f0-9]{64}$/.test(digest) ? digest : null;
}
