import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { smokeRunningDaemon } from "./daemon-smoke.mjs";
import { requirePreviewRepository } from "./source.mjs";
import { runNpm } from "./npm.mjs";
import { isMainModule } from "../is-main-module.mjs";
import {
  downloadForkPreview,
  selectForkPreview,
} from "../../packages/server/dist/server/server/session/daemon/fork-preview.js";

/**
 * Prove a published standalone daemon updates in place: install the previous complete preview
 * into a temporary prefix, then update it to the newest one through the host RPC.
 * `repository` must be the fork repository. Keeps the prefix on failure for inspection.
 */
export async function verifyPublishedDaemonUpdate({ repository: requestedRepository }) {
  const repository = requirePreviewRepository(requestedRepository);
  // Use the same release selector and checksum verifier that the running daemon uses.
  const batches = JSON.parse(
    execFileSync(
      "gh",
      ["api", `repos/${repository}/releases?per_page=100`, "--paginate", "--slurp"],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    ),
  );
  const releases = batches.flat();
  const latest = selectForkPreview(releases);
  const targetTag = new URL(latest.packageAsset.browser_download_url).pathname.split("/")[5];
  const olderReleases = releases.filter((release) => release.tag_name !== targetTag);
  // Fail when there are not two complete published previews; never count a reinstall as an upgrade.
  const previous = selectForkPreview(olderReleases);
  const previousTag = new URL(previous.packageAsset.browser_download_url).pathname.split("/")[5];
  const previousRelease = olderReleases.find((release) => release.tag_name === previousTag);
  const download = await downloadForkPreview({
    async request(url) {
      if (url.startsWith("https://api.github.com/")) return Response.json([previousRelease]);
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`Release download failed: HTTP ${response.status}`);
      return response;
    },
  });
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-fork-update-proof-"));
  let smokePassed = false;
  try {
    runNpm(
      [
        "install",
        "-g",
        "--prefix",
        directory,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        download.file,
      ],
      { stdio: "inherit", timeout: 300_000 },
    );
    const globalRoot = runNpm(["root", "-g", "--prefix", directory], { encoding: "utf8" }).trim();
    await smokeRunningDaemon({
      packageRoot: path.join(globalRoot, "@ryanewen/paseo-daemon"),
      updateVersion: targetTag.slice(1),
    });
    smokePassed = true;
  } finally {
    await download.cleanup();
    if (smokePassed) {
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    } else {
      process.stderr.write(`Update smoke failed; preserved installation prefix: ${directory}\n`);
    }
  }
}

if (isMainModule(import.meta.url)) {
  await verifyPublishedDaemonUpdate({ repository: process.env.GITHUB_REPOSITORY });
}
