import { z } from "zod";
import { getDeviceTimeZone } from "@/utils/device-timezone";
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
 * Each body becomes the release's highlights with no sections, so the sheet shows the
 * notes whole, as published, instead of tucking `###` sections behind "Show all changes".
 *
 * Throws when the payload is not a list (for example a GitHub error object such as a rate
 * limit), so the caller shows its error state. Individual entries that are malformed, drafts
 * or lack notes are skipped rather than failing the whole list.
 *
 * @param timeZone IANA zone that decides each release's calendar date. Defaults to the
 *   viewer's zone, since a publish time is an instant and readers are everywhere.
 */
export function parseGitHubReleases(
  payload: unknown,
  timeZone: string = getDeviceTimeZone(),
): ChangelogRelease[] {
  const entries = z.array(z.unknown()).safeParse(payload);
  if (!entries.success) {
    throw new Error("Expected a GitHub releases list");
  }

  const published = entries.data.map(readRelease).filter(isPublished);

  // GitHub orders by creation time; a previously drafted release can publish later.
  published.sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));

  return published.map((entry) => ({
    version: entry.tag_name.replace(/^v(?=\d)/, ""),
    date: toCalendarDate(entry.published_at, timeZone),
    highlights: entry.body,
    sections: [],
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

/**
 * The `YYYY-MM-DD` calendar date of an instant in the given zone. Built from the
 * formatter's parts so it does not depend on any locale's short-date layout.
 */
function toCalendarDate(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));

  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}
