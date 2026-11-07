import { z } from "zod";
import type { ChangelogRelease } from "./parse-changelog";

/** The fields of a GitHub release that What's new reads. */
const GitHubReleaseSchema = z.object({
  draft: z.boolean(),
  tag_name: z.string(),
  body: z.string().nullable(),
  published_at: z.string().nullable(),
});

type GitHubRelease = z.infer<typeof GitHubReleaseSchema>;

/** A release that has been published with notes worth showing. */
type PublishedRelease = GitHubRelease & { body: string; published_at: string };

/**
 * Read published fork notes without interpreting Markdown headings as release boundaries.
 *
 * Throws when the payload is not a list (for example a GitHub error object such as a rate
 * limit), so the caller shows its error state. Individual entries that are malformed, drafts
 * or lack notes are skipped rather than failing the whole list.
 */
export function parseGitHubReleases(payload: unknown): ChangelogRelease[] {
  const entries = z.array(z.unknown()).safeParse(payload);
  if (!entries.success) {
    throw new Error("Expected a GitHub releases list");
  }

  const published = entries.data.map(readRelease).filter(isPublished);

  // GitHub orders by creation time; a previously drafted release can publish later.
  published.sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));

  return published.map((entry) => ({
    version: entry.tag_name.replace(/^v(?=\d)/, ""),
    date: new Date(entry.published_at).toLocaleDateString("en-CA", {
      timeZone: "America/Toronto",
    }),
    sections: [{ title: null, body: entry.body }],
  }));
}

/** Validates one list entry; a malformed entry becomes null so it can be skipped. */
function readRelease(entry: unknown): GitHubRelease | null {
  const result = GitHubReleaseSchema.safeParse(entry);
  return result.success ? result.data : null;
}

/** Keeps published releases that carry notes and a usable publish time. */
function isPublished(release: GitHubRelease | null): release is PublishedRelease {
  if (release === null || release.draft) {
    return false;
  }

  const hasNotes = release.body !== null && release.body.trim().length > 0;
  const hasPublishTime =
    release.published_at !== null && Number.isFinite(Date.parse(release.published_at));
  return hasNotes && hasPublishTime;
}
