import { describe, expect, it } from "vitest";
import { parseGitHubReleases } from "./parse-github-releases";

describe("parseGitHubReleases", () => {
  it("shows published previews newest first, preserves headings and hides drafts", () => {
    const notes = "## Features\n\nFork notes\n\n### Fixed\n\n- A fix";
    const releases = parseGitHubReleases([
      {
        draft: false,
        tag_name: "v0.11.2-preview.27",
        published_at: "2026-10-09T01:00:00Z",
        body: notes,
      },
      { draft: true, tag_name: "v0.11.2-preview.28", published_at: null, body: "Unpublished" },
      {
        draft: false,
        tag_name: "v0.11.2-preview.29",
        published_at: "2026-10-11T20:00:00Z",
        body: "New fork notes",
      },
    ]);
    expect(releases.map((release) => release.version)).toEqual([
      "0.11.2-preview.29",
      "0.11.2-preview.27",
    ]);
    expect(releases[1].sections).toEqual([{ title: null, body: notes }]);
  });
  it("dates each release by the viewer's own calendar day", () => {
    const payload = [
      {
        draft: false,
        tag_name: "v0.11.2-preview.27",
        published_at: "2026-10-09T01:00:00Z",
        body: "Fork notes",
      },
    ];
    expect(parseGitHubReleases(payload, "Asia/Tokyo")[0].date).toBe("2026-10-09");
    expect(parseGitHubReleases(payload, "America/Los_Angeles")[0].date).toBe("2026-10-08");
    expect(parseGitHubReleases(payload, "UTC")[0].date).toBe("2026-10-09");
  });
  it("rejects API error payloads and omits unusable release notes", () => {
    expect(() => parseGitHubReleases({ message: "rate limited" })).toThrow(
      "Expected a GitHub releases list",
    );
    expect(
      parseGitHubReleases([
        null,
        { draft: false, tag_name: "v1", body: "", published_at: "invalid" },
      ]),
    ).toEqual([]);
  });
});
