import { getGitHubRelease } from "../github-release.mjs";

/**
 * Wait for GitHub to expose a newly created draft without treating authentication errors as absence.
 *
 * Draft releases appear in the releases list a moment after creation, so a lookup can briefly
 * return null. Lookup errors (authentication, network) are rethrown immediately, not retried.
 * Returns the release, or null when it is still invisible after every attempt.
 */
export async function waitForGitHubRelease(
  repo,
  tag,
  {
    attempts = 5,
    delayMs = 1_000,
    lookup = getGitHubRelease,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {},
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const release = lookup(repo, tag);
    if (release) return release;
    if (attempt < attempts - 1) await sleep(delayMs);
  }
  return null;
}

/**
 * Confirm that a draft holds exactly the validated assets after upload.
 *
 * `names` is the sorted list of file names that were uploaded. Throws when GitHub reports a
 * different set, leaving the release as a draft.
 */
export function requireUploadedDraftAssets({ repo, tag, names, lookup = getGitHubRelease }) {
  const uploaded = lookup(repo, tag);
  const uploadedNames = uploaded.assets.map((asset) => asset.name).sort();
  if (JSON.stringify(uploadedNames) !== JSON.stringify(names)) {
    throw new Error(
      "Uploaded release assets do not match the validated set; the release remains a draft",
    );
  }
}
