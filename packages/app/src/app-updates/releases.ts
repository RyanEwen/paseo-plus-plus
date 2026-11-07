import { z } from "zod";

// The daemon's fork-preview.ts (server package) applies the same tag, build-number, repository and
// canonical-URL rules to host updates. The app cannot import it (Node-only module), so keep both in
// step until the rules move to a module both packages share.

// Discover through the current repository; retain canonical legacy asset URL compatibility.
const repository = "RyanEwen/paseo-plus-plus";
const releaseRepositories = [repository, "RyanEwen/paseo"];
const previewTagPattern = /^v\d+\.\d+\.\d+-preview\.(\d+)$/;
const safeAssetNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Preview Android version codes are this offset plus the workflow build number. */
const previewVersionCodeOffset = 1_000_000_000;
/** Keeps preview version codes within Google Play's 2_100_000_000 maximum. */
const maxPreviewBuild = 1_100_000_000;
const releasesPerPage = 100;
/** GitHub lists at most 1000 releases, so later pages are never needed. */
const maxReleasePages = 10;

const assetSchema = z.object({ name: z.string(), browser_download_url: z.url() });
const releaseSchema = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  assets: z.array(assetSchema),
});
export const releasesSchema = z.array(releaseSchema);

/** One GitHub release, as validated at the API boundary. */
export type ForkRelease = z.infer<typeof releaseSchema>;
type ForkReleaseAsset = z.infer<typeof assetSchema>;

export interface AndroidUpdate {
  version: string;
  versionCode: number;
  url: string;
  checksumUrl: string;
  filename: string;
}

/** The fetch subset the release client uses, so tests can supply canned responses. */
export type UpdateFetch = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

/** Call the platform fetch through a wrapper so it is never invoked detached from its global. */
const defaultFetch: UpdateFetch = (url, init) => fetch(url, init);

interface PreviewBuild {
  release: ForkRelease;
  versionCode: number;
}

/**
 * Published fork previews with their Android version codes, newest first.
 * Drafts and tags outside the preview namespace are ignored.
 */
function listPreviewBuilds(releases: ForkRelease[]): PreviewBuild[] {
  const previews = releases.flatMap((release) => {
    const match = previewTagPattern.exec(release.tag_name);
    // The final prerelease bridges older installs to normal GitHub releases with the same tags.
    if (release.draft || !match) return [];
    const build = Number(match[1]);
    if (!Number.isSafeInteger(build) || build < 1 || build > maxPreviewBuild) {
      throw new Error("Invalid preview build number");
    }
    return [{ release, versionCode: previewVersionCodeOffset + build }];
  });
  return previews.sort((a, b) => b.versionCode - a.versionCode);
}

/** Refuse an asset whose name is unsafe or whose URL is not a canonical fork download. */
function assertCanonicalAsset(asset: ForkReleaseAsset, tag: string): void {
  const safeName = safeAssetNamePattern.test(asset.name) && !asset.name.includes("..");
  const canonicalAssetUrl = releaseRepositories.some((candidate) => {
    const expected = `https://github.com/${candidate}/releases/download/${tag}/${asset.name}`;
    return asset.browser_download_url === expected;
  });
  if (!safeName || !canonicalAssetUrl) {
    throw new Error("Unexpected fork release asset URL");
  }
}

/** Pick the release's single APK and its SHA256SUMS, both from canonical fork URLs. */
function selectReleaseAssets(release: ForkRelease): {
  apk: ForkReleaseAsset;
  checksum: ForkReleaseAsset;
} {
  const apks = release.assets.filter((asset) => asset.name.endsWith(".apk"));
  const checksum = release.assets.find((asset) => asset.name === "SHA256SUMS");
  if (apks.length !== 1 || !checksum) throw new Error("Preview is missing its APK or checksum");
  const apk = apks[0];
  assertCanonicalAsset(apk, release.tag_name);
  assertCanonicalAsset(checksum, release.tag_name);
  return { apk, checksum };
}

/**
 * Select published fork builds by workflow sequence, regardless of GitHub's prerelease flag.
 * Returns null when the newest preview is not newer than the installed version code; throws when
 * that newest preview is malformed rather than falling back to an older one.
 */
export function selectAndroidUpdate(
  releases: ForkRelease[],
  installedCode: number,
): AndroidUpdate | null {
  const latest = listPreviewBuilds(releases)[0];
  if (!latest || latest.versionCode <= installedCode) return null;
  const { apk, checksum } = selectReleaseAssets(latest.release);
  return {
    version: latest.release.tag_name.slice(1),
    versionCode: latest.versionCode,
    url: apk.browser_download_url,
    checksumUrl: checksum.browser_download_url,
    filename: apk.name,
  };
}

/** Reject absent or ambiguous checksums before asking native code to download an APK. */
export function readApkChecksum(text: string, filename: string): string {
  const entries = text.split("\n").filter((line) => line.endsWith(`  ${filename}`));
  if (entries.length !== 1 || !/^[a-f0-9]{64}  /.test(entries[0])) {
    throw new Error("Invalid APK checksum inventory");
  }
  return entries[0].slice(0, 64);
}

/** GitHub refused the request because this network used up its unauthenticated API allowance. */
export class GitHubRateLimitError extends Error {
  constructor() {
    super("GitHub rate limit reached. Try again later.");
    this.name = "GitHubRateLimitError";
  }
}

/** GitHub signals an exhausted allowance with 429, or 403 and no remaining requests. */
function isRateLimited(response: Response): boolean {
  if (response.status === 429) return true;
  return response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0";
}

/** Bound each metadata request; public releases need no GitHub credentials. */
export async function requestUpdateResource(
  url: string,
  { fetch: request = defaultFetch }: { fetch?: UpdateFetch } = {},
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await request(url, { signal: controller.signal });
    if (isRateLimited(response)) throw new GitHubRateLimitError();
    if (!response.ok) throw new Error(`Update request failed (HTTP ${response.status})`);
    // Consume metadata inside the timeout, not only the response headers.
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Read every release page so unrelated tags cannot hide the newest fork preview, up to the
 * 1000 releases GitHub will list.
 */
export async function findAndroidUpdate(
  installedCode: number,
  options: { fetch?: UpdateFetch } = {},
): Promise<AndroidUpdate | null> {
  const releases: ForkRelease[] = [];
  for (let page = 1; page <= maxReleasePages; page += 1) {
    const response = await requestUpdateResource(
      `https://api.github.com/repos/${repository}/releases?per_page=${releasesPerPage}&page=${page}`,
      options,
    );
    // Validate at the API boundary; selection below trusts the parsed type.
    const batch = releasesSchema.parse(JSON.parse(response));
    releases.push(...batch);
    if (batch.length < releasesPerPage) break;
  }
  return selectAndroidUpdate(releases, installedCode);
}
