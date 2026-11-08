import { describe, expect, it } from "vitest";
import {
  buildForkReleasesPageUrl,
  isCanonicalForkAssetUrl,
  parseForkPreviewBuild,
  readForkChecksum,
} from "./fork-release.js";

const DIGEST = "a".repeat(64);
const TAG = "v0.15.0-preview.42";

/** An asset named daemon.tgz hosted at `url`. */
function asset(url: string) {
  return { name: "daemon.tgz", browser_download_url: url };
}

describe("fork release rules", () => {
  it("builds release listing URLs for the current repository", () => {
    expect(buildForkReleasesPageUrl(3)).toBe(
      "https://api.github.com/repos/RyanEwen/paseo-plus-plus/releases?per_page=100&page=3",
    );
  });

  it("reads preview build numbers and ignores other tags", () => {
    expect(parseForkPreviewBuild(TAG)).toBe(42);
    expect(parseForkPreviewBuild("v0.15.0")).toBeNull();
    expect(parseForkPreviewBuild("v0.15.0-beta.1")).toBeNull();
  });

  it.each(["v0.15.0-preview.0", "v0.15.0-preview.1100000001"])(
    "throws for the out-of-range preview tag %s",
    (tag) => {
      expect(() => parseForkPreviewBuild(tag)).toThrow("Invalid preview build number");
    },
  );

  it.each(["RyanEwen/paseo-plus-plus", "RyanEwen/paseo"])(
    "accepts assets from %s",
    (repository) => {
      const url = `https://github.com/${repository}/releases/download/${TAG}/daemon.tgz`;
      expect(isCanonicalForkAssetUrl({ asset: asset(url), tagName: TAG })).toBe(true);
    },
  );

  it.each([
    "https://example.com/daemon.tgz",
    "https://github.com/AnotherOwner/paseo/releases/download/v0.15.0-preview.42/daemon.tgz",
    "https://github.com/RyanEwen/paseo/releases/download/v0.15.0-preview.42/daemon.tgz?x=1",
    "https://github.com/RyanEwen/paseo/releases/download/v0.15.0-preview.41/daemon.tgz",
  ])("rejects the non-canonical asset URL %s", (url) => {
    expect(isCanonicalForkAssetUrl({ asset: asset(url), tagName: TAG })).toBe(false);
  });

  it("reads a single well-formed checksum line", () => {
    const checksums = `${"b".repeat(64)}  other.tgz\n${DIGEST}  daemon.tgz\n`;
    expect(readForkChecksum({ checksums, filename: "daemon.tgz" })).toBe(DIGEST);
  });

  it.each([
    ["missing", `${DIGEST}  other.tgz`],
    ["duplicated", `${DIGEST}  daemon.tgz\n${DIGEST}  daemon.tgz`],
    ["uppercase", `${"A".repeat(64)}  daemon.tgz`],
    ["short", "abc123  daemon.tgz"],
    ["padded", `${DIGEST}  junk  daemon.tgz`],
  ])("returns null for a %s checksum entry", (_case, checksums) => {
    expect(readForkChecksum({ checksums, filename: "daemon.tgz" })).toBeNull();
  });
});
