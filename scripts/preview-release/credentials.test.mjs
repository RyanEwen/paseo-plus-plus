import assert from "node:assert/strict";
import test from "node:test";
import { PREVIEW_CREDENTIAL_NAMES, requirePreviewCredentials } from "./credentials.mjs";

const complete = Object.fromEntries(PREVIEW_CREDENTIAL_NAMES.map((name) => [name, "value"]));

test("accepts a release environment with every preview credential", () => {
  requirePreviewCredentials(complete);
});

test("names every missing or blank preview credential", () => {
  assert.throws(
    () =>
      requirePreviewCredentials({ ...complete, KEY_ALIAS: " ", AZURE_CLIENT_SECRET: undefined }),
    /^Error: Missing preview credentials: AZURE_CLIENT_SECRET, KEY_ALIAS$/,
  );
});
