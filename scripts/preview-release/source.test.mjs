import assert from "node:assert/strict";
import test from "node:test";
import {
  requirePreviewRepository,
  requirePreviewSource,
  requireSuccessfulSourceCi,
} from "./source.mjs";

test("preview operations accept only exact fork repositories and integration refs during the rename", () => {
  const commit = "a".repeat(40);
  // COMPAT(forkRepositoryRename, forkIntegrationRename): drop RyanEwen/paseo and ryan/preview
  // from these lists after 2027-04-14.
  for (const repository of ["RyanEwen/paseo", "RyanEwen/paseo-plus-plus"]) {
    assert.equal(requirePreviewRepository(repository), repository);
    for (const branch of ["ryan/preview", "main"]) {
      requirePreviewSource({ repository, ref: `refs/heads/${branch}`, commit });
    }
    for (const ref of [
      "refs/heads/upstream/main",
      "refs/heads/ryan/dev",
      "refs/tags/main",
      "main",
    ]) {
      assert.throws(() => requirePreviewSource({ repository, ref, commit }), /workflow on/);
    }
    assert.throws(
      () => requirePreviewSource({ repository, ref: "refs/heads/main", commit: "short-sha" }),
      /full Git commit/,
    );
  }
  for (const repository of [
    "getpaseo/paseo",
    "other/paseo-plus-plus",
    "RyanEwen/paseo-plus-plus-extra",
    "ryanewen/paseo-plus-plus",
    "RyanEwen/paseo/",
    undefined,
  ]) {
    assert.throws(() => requirePreviewRepository(repository), /Preview releases require/);
  }
});

test("preview source CI rejects missing, mismatched, failed, or unfinished push runs", () => {
  const commit = "a".repeat(40);
  const run = {
    head_sha: commit,
    // COMPAT(forkIntegrationRename): use main here after 2027-04-14.
    head_branch: "ryan/preview",
    event: "push",
    status: "completed",
    conclusion: "success",
  };
  requireSuccessfulSourceCi({ commit, runs: { workflow_runs: [run] } });
  requireSuccessfulSourceCi({
    commit,
    runs: { workflow_runs: [{ ...run, head_branch: "main" }] },
  });
  for (const overrides of [
    { head_sha: "b".repeat(40) },
    { head_branch: "upstream/main" },
    { event: "pull_request" },
    { status: "in_progress", conclusion: null },
    { conclusion: "failure" },
    { conclusion: "cancelled" },
    { conclusion: "skipped" },
  ]) {
    assert.throws(
      () =>
        requireSuccessfulSourceCi({ commit, runs: { workflow_runs: [{ ...run, ...overrides }] } }),
      /Source push CI must pass/,
    );
  }
  assert.throws(
    () => requireSuccessfulSourceCi({ commit, runs: { workflow_runs: [] } }),
    /Source push CI must pass/,
  );
  assert.throws(
    () =>
      requireSuccessfulSourceCi({
        commit,
        runs: { workflow_runs: [{ ...run, conclusion: "failure" }, run] },
      }),
    /Source push CI must pass/,
  );
});
