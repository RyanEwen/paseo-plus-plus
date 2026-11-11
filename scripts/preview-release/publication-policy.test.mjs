import assert from "node:assert/strict";
import test from "node:test";
import {
  fingerprintBridgeAssets,
  requirePreviewNotes,
  resolvePublicationPolicy,
  updaterBridgeMarker,
} from "./publication-policy.mjs";

function publicationFixture() {
  const assets = [
    {
      id: 101,
      name: "preview-release.json",
      size: 456,
      digest: `sha256:${"a".repeat(64)}`,
      state: "uploaded",
    },
    {
      id: 102,
      name: "SHA256SUMS",
      size: 789,
      digest: `sha256:${"b".repeat(64)}`,
      state: "uploaded",
    },
  ];
  const bridge = {
    id: 123,
    tag_name: "v0.11.2-preview.77",
    target_commitish: "a".repeat(40),
    draft: false,
    prerelease: true,
    body: updaterBridgeMarker,
    assets,
  };
  return {
    kind: "latest",
    release: {
      tag: "v0.11.2-preview.80",
      version: "0.11.2-preview.80",
      buildNumber: 80,
      commit: "b".repeat(40),
    },
    qualifiedBridge: {
      schemaVersion: 1,
      releaseId: bridge.id,
      tag: bridge.tag_name,
      commit: bridge.target_commitish,
      assetFingerprint: fingerprintBridgeAssets(assets),
      qualificationEvidence: "docs/qa-evidence/updater-bridge/acceptance.md",
    },
    retainedBridge: {
      releaseId: bridge.id,
      tag: bridge.tag_name,
      commit: bridge.target_commitish,
      assetFingerprint: fingerprintBridgeAssets(assets),
    },
    releases: [bridge],
  };
}

test("normal Latest publication stays closed until a published bridge is qualified in reviewed source", () => {
  const fixture = publicationFixture();
  assert.throws(
    () => resolvePublicationPolicy({ ...fixture, qualifiedBridge: null }),
    /reviewed qualified-bridge receipt/,
  );
  assert.deepEqual(resolvePublicationPolicy(fixture), { prerelease: false, makeLatest: true });
  assert.deepEqual(
    resolvePublicationPolicy({ ...fixture, kind: "bridge", qualifiedBridge: null, releases: [] }),
    { prerelease: true, makeLatest: false },
  );
  assert.throws(
    () => resolvePublicationPolicy({ ...fixture, kind: "stable" }),
    /kind must be bridge, preview or latest/,
  );
  assert.throws(
    () => resolvePublicationPolicy({ ...fixture, kind: "bridge" }),
    /final updater bridge already exists/,
  );
  assert.throws(
    () => resolvePublicationPolicy({ ...fixture, kind: "bridge", qualifiedBridge: null }),
    /final updater bridge already exists/,
  );
});

test("previews publish as normal Latest releases while the prerelease bridge is retained", () => {
  const fixture = { ...publicationFixture(), kind: "preview", qualifiedBridge: null };
  assert.deepEqual(resolvePublicationPolicy(fixture), { prerelease: false, makeLatest: true });
  assert.throws(
    () => resolvePublicationPolicy({ ...fixture, kind: "latest" }),
    /reviewed qualified-bridge receipt/,
  );
  for (const retainedBridge of [null, {}, { tag: fixture.releases[0].tag_name }]) {
    assert.throws(
      () => resolvePublicationPolicy({ ...fixture, retainedBridge }),
      /bridge retention evidence/,
    );
  }
  assert.throws(
    () => resolvePublicationPolicy({ ...fixture, kind: "bridge" }),
    /final updater bridge already exists/,
  );
});

test("non-bridge release notes cannot create a second bridge marker", () => {
  for (const kind of ["preview", "latest"]) {
    assert.throws(() => requirePreviewNotes(updaterBridgeMarker, kind), /marker is reserved/);
    assert.doesNotThrow(() => requirePreviewNotes("Reviewed changes", kind));
  }
  for (const notes of [undefined, null, "", "  ", {}]) {
    assert.throws(() => requirePreviewNotes(notes, "preview"), /user-facing release notes/);
  }
  assert.doesNotThrow(() => requirePreviewNotes(updaterBridgeMarker, "bridge"));
});

test("normal release gate requires the exact retained prerelease and its asset inventory", () => {
  const fixture = publicationFixture();
  const bridge = fixture.releases[0];
  for (const replacement of [
    { ...bridge, draft: true },
    { ...bridge, prerelease: false },
    { ...bridge, id: bridge.id + 1 },
    { ...bridge, target_commitish: "c".repeat(40) },
    { ...bridge, body: "Unmarked old preview" },
    { ...bridge, assets: bridge.assets.slice(1) },
    { ...bridge, assets: [...bridge.assets, { ...bridge.assets[0], id: 103, name: "extra.apk" }] },
  ]) {
    for (const kind of ["latest", "preview"]) {
      assert.throws(
        () => resolvePublicationPolicy({ ...fixture, kind, releases: [replacement] }),
        /immutable assets must remain published/,
      );
    }
  }
  for (const kind of ["latest", "preview"]) {
    assert.throws(
      () => resolvePublicationPolicy({ ...fixture, kind, releases: [] }),
      /immutable assets must remain published/,
    );
  }
  for (const qualificationEvidence of [
    "../receipt.md",
    "docs/qa-evidence/../receipt.md",
    "https://example.com/receipt.md",
  ]) {
    assert.throws(
      () =>
        resolvePublicationPolicy({
          ...fixture,
          qualifiedBridge: { ...fixture.qualifiedBridge, qualificationEvidence },
        }),
      /reviewed qualified-bridge receipt/,
    );
  }
});

test("normal publication preserves the native counter and desktop ordering without assuming the next run number", () => {
  const fixture = publicationFixture();
  for (const [version, buildNumber] of [
    ["0.11.2-preview.77", 77],
    ["0.11.2-preview.76", 76],
    ["0.11.1-preview.81", 81],
  ]) {
    for (const kind of ["latest", "preview"]) {
      assert.throws(
        () =>
          resolvePublicationPolicy({
            ...fixture,
            kind,
            release: { ...fixture.release, tag: `v${version}`, version, buildNumber },
          }),
        /advance the published/,
      );
    }
  }
  assert.throws(
    () =>
      resolvePublicationPolicy({
        ...fixture,
        releases: [
          ...fixture.releases,
          {
            ...fixture.releases[0],
            id: 124,
            tag_name: "v0.11.3-preview.81",
            prerelease: false,
            body: "Normal release",
          },
        ],
      }),
    /advance the published/,
  );
  assert.throws(
    () =>
      resolvePublicationPolicy({ ...fixture, release: { ...fixture.release, buildNumber: 81 } }),
    /provenance/,
  );
  assert.throws(
    () => resolvePublicationPolicy({ ...fixture, release: { ...fixture.release, tag: "v0.11.2" } }),
    /canonical fork workflow tag/,
  );
  assert.throws(
    () =>
      resolvePublicationPolicy({
        ...fixture,
        release: { ...fixture.release, tag: "v0.11.2-preview.1100000001" },
      }),
    /valid build number/,
  );
});

test("qualified bridge fingerprint detects replaced assets and ignores API inventory order", () => {
  const assets = publicationFixture().releases[0].assets;
  const fingerprint = fingerprintBridgeAssets(assets);
  assert.equal(fingerprintBridgeAssets(assets.toReversed()), fingerprint);
  for (const change of [
    { id: 999 },
    { size: 999 },
    { name: "replaced.json" },
    { digest: `sha256:${"c".repeat(64)}` },
  ]) {
    assert.notEqual(fingerprintBridgeAssets([{ ...assets[0], ...change }, assets[1]]), fingerprint);
  }
  for (const invalid of [
    [],
    [assets[0], assets[0]],
    [{ ...assets[0], state: "new" }],
    [{ ...assets[0], digest: null }],
  ]) {
    assert.throws(() => fingerprintBridgeAssets(invalid), /bridge asset/);
  }
});
