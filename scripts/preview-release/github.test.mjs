import assert from "node:assert/strict";
import test from "node:test";
import { requireUploadedDraftAssets, waitForGitHubRelease } from "./github.mjs";

test("waits for delayed draft visibility without creating another release", async () => {
  const release = { id: 42, draft: true };
  let attempts = 0;
  const waits = [];
  const found = await waitForGitHubRelease("RyanEwen/paseo", "v0.11.2-preview.27", {
    lookup: () => (++attempts === 3 ? release : null),
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
    },
  });
  assert.deepEqual(found, release);
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [1_000, 1_000]);
});

test("does not retry an authentication failure while waiting for a draft", async () => {
  const failure = new Error("authentication failed");
  let attempts = 0;
  await assert.rejects(
    waitForGitHubRelease("RyanEwen/paseo", "v0.11.2-preview.27", {
      lookup: () => {
        attempts += 1;
        throw failure;
      },
    }),
    failure,
  );
  assert.equal(attempts, 1);
});

test("accepts a draft whose uploaded assets match the validated set", () => {
  requireUploadedDraftAssets({
    repo: "RyanEwen/paseo-plus-plus",
    tag: "v0.15.3-preview.43",
    names: ["SHA256SUMS", "app.apk"],
    lookup: () => ({ assets: [{ name: "app.apk" }, { name: "SHA256SUMS" }] }),
  });
});

test("rejects a draft whose uploaded assets differ from the validated set", () => {
  assert.throws(
    () =>
      requireUploadedDraftAssets({
        repo: "RyanEwen/paseo-plus-plus",
        tag: "v0.15.3-preview.43",
        names: ["SHA256SUMS", "app.apk"],
        lookup: () => ({ assets: [{ name: "app.apk" }] }),
      }),
    /do not match the validated set/,
  );
});
