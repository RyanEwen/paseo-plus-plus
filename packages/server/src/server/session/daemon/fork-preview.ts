import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";

// Discover releases through the current repository.
const REPOSITORY = "RyanEwen/paseo-plus-plus";
// COMPAT(fork-repo-rename): added in v0.11.2-preview, remove after the final prerelease updater
// bridge is retired (no calendar date; see docs/release.md, final prerelease bridge).
// Releases published before the rename keep canonical asset URLs under the legacy name.
const RELEASE_REPOSITORIES = [REPOSITORY, "RyanEwen/paseo"];
const ReleaseAssetSchema = z.object({ name: z.string(), browser_download_url: z.string().url() });
const ReleaseSchema = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  assets: z.array(ReleaseAssetSchema),
});

type ReleaseAsset = z.infer<typeof ReleaseAssetSchema>;

/** The newest installable fork preview for this host's platform and architecture. */
export interface ForkPreviewSelection {
  /** Release version without the tag's leading "v". */
  version: string;
  /** Daemon package filename, as listed in SHA256SUMS. */
  filename: string;
  packageAsset: ReleaseAsset;
  checksumAsset: ReleaseAsset;
}

/** A verified daemon package on disk. Call cleanup once npm has installed it. */
export interface DownloadedForkPreview {
  file: string;
  cleanup(): Promise<void>;
}

/** Select published fork builds by workflow sequence, regardless of GitHub's prerelease flag. */
export function selectForkPreview(value: unknown): ForkPreviewSelection {
  const releases = z.array(ReleaseSchema).parse(value);
  const previews = releases.flatMap((release) => {
    const match = /^v\d+\.\d+\.\d+-preview\.(\d+)$/.exec(release.tag_name);
    // Keep the tag namespace and monotonic counter when GitHub classification changes.
    if (release.draft || !match) return [];
    const build = Number(match[1]);
    // Android preview version codes are 1_000_000_000 + build and must stay within Google
    // Play's 2_100_000_000 maximum, so a larger build number cannot be a real preview.
    if (!Number.isSafeInteger(build) || build < 1 || build > 1_100_000_000) {
      throw new Error("Invalid preview build number");
    }
    return [{ release, build }];
  });
  previews.sort((left, right) => right.build - left.build);
  const release = previews[0]?.release;
  if (!release) throw new Error("No published fork daemon preview is available");
  const filename = `paseo-daemon-${release.tag_name.slice(1)}-${process.platform}-${process.arch}.tgz`;
  const packageAsset = release.assets.find((asset) => asset.name === filename);
  const checksumAsset = release.assets.find((asset) => asset.name === "SHA256SUMS");
  if (!packageAsset || !checksumAsset)
    throw new Error(`Fork preview has no daemon package for ${process.platform}/${process.arch}`);
  for (const asset of [packageAsset, checksumAsset]) {
    const canonicalAssetUrl = RELEASE_REPOSITORIES.some((repository) => {
      const expected = `https://github.com/${repository}/releases/download/${release.tag_name}/${asset.name}`;
      return asset.browser_download_url === expected;
    });
    if (!canonicalAssetUrl) throw new Error("Unexpected fork release asset URL");
  }
  return { version: release.tag_name.slice(1), filename, packageAsset, checksumAsset };
}

/** Verify downloaded bytes before npm can replace the running installation. */
export function verifyForkChecksum({
  checksums,
  filename,
  bytes,
}: {
  /** SHA256SUMS contents. */
  checksums: string;
  filename: string;
  bytes: Uint8Array;
}): void {
  const entries = checksums.split("\n").filter((line) => line.endsWith(`  ${filename}`));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (entries.length !== 1 || entries[0] !== `${digest}  ${filename}`) {
    throw new Error("Fork daemon package checksum mismatch");
  }
}

/** Read a public release resource with a bounded network request. */
async function requestRelease(url: string): Promise<Response> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(120_000),
    headers: { "User-Agent": "paseo-fork-updater" },
  });
  if (!response.ok) throw new Error(`Fork release download failed: HTTP ${response.status}`);
  return response;
}

interface DownloadOptions {
  request?: (url: string) => Promise<Response>;
}

/** Resolve the installable preview without downloading or changing the host installation. */
export async function resolveForkPreview({
  request = requestRelease,
}: DownloadOptions = {}): Promise<ForkPreviewSelection> {
  // Pagination avoids losing the newest preview behind stable releases or other prereleases.
  const releases = [];
  for (let page = 1; ; page += 1) {
    const response = await request(
      `https://api.github.com/repos/${REPOSITORY}/releases?per_page=100&page=${page}`,
    );
    const batch = z.array(ReleaseSchema).parse(await response.json());
    releases.push(...batch);
    if (batch.length < 100) break;
  }
  return selectForkPreview(releases);
}

/** Download only public releases; draft and incomplete releases never fall back to upstream npm. */
export async function downloadForkPreview({
  request = requestRelease,
}: DownloadOptions = {}): Promise<DownloadedForkPreview> {
  const preview = await resolveForkPreview({ request });
  const checksums = await (await request(preview.checksumAsset.browser_download_url)).text();
  const bytes = new Uint8Array(
    await (await request(preview.packageAsset.browser_download_url)).arrayBuffer(),
  );
  verifyForkChecksum({ checksums, filename: preview.filename, bytes });
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-fork-update-"));
  const file = path.join(directory, preview.filename);
  try {
    await writeFile(file, bytes);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return { file, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
