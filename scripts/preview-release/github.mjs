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
