import { expect, type Locator, type Page } from "@playwright/test";

const CHANGELOG_SOURCE_URL =
  "https://api.github.com/repos/RyanEwen/paseo-plus-plus/releases?per_page=100";

/** One fork release as a test describes it; mapped to GitHub's wire shape when served. */
export interface ReleaseFixture {
  version: string;
  /** ISO publish instant, or null for a draft that has never been published. */
  publishedAt: string | null;
  body: string;
  draft?: boolean;
}

interface ServeReleasesOptions {
  /** Answer with a GitHub rate-limit error until the returned handle restores the releases. */
  unavailable?: boolean;
}

interface ServedReleases {
  /** Serve the releases from now on, after starting unavailable. */
  restore: () => void;
}

/**
 * Serves the fork's GitHub releases to the app instead of the live API.
 *
 * The sheet renders each release body as Markdown, so a fixture is how a test
 * states which authoring shapes it cares about.
 */
export async function serveReleases(
  page: Page,
  releases: ReleaseFixture[],
  options: ServeReleasesOptions = {},
): Promise<ServedReleases> {
  let unavailable = options.unavailable ?? false;

  await page.route(CHANGELOG_SOURCE_URL, (route) => {
    if (unavailable) {
      return route.fulfill({ status: 403, json: { message: "API rate limit exceeded" } });
    }
    return route.fulfill({ json: releases.map(toGitHubRelease) });
  });

  return {
    restore: () => {
      unavailable = false;
    },
  };
}

function toGitHubRelease(fixture: ReleaseFixture) {
  return {
    tag_name: `v${fixture.version}`,
    draft: fixture.draft ?? false,
    published_at: fixture.publishedAt,
    body: fixture.body,
  };
}

export async function openWhatsNew(page: Page): Promise<Locator> {
  await page.getByTestId("sidebar-help").click();
  await expect(page.getByTestId("sidebar-help-menu")).toBeVisible();
  await page.getByTestId("sidebar-help-changelog").click();

  const sheet = page.getByTestId("changelog-sheet");
  await expect(sheet).toBeVisible();
  return sheet;
}

export function release(sheet: Locator, version: string): Locator {
  return sheet.getByTestId(`changelog-release-${version}`);
}
