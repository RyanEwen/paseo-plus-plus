import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { requireFirebasePackage, writeAndroidSigningFiles } from "./android-signing-files.mjs";

const firebase = (packageName) => ({
  client: [{ client_info: { android_client_info: { package_name: packageName } } }],
});

test("requires a Firebase Android client for the preview package", () => {
  requireFirebasePackage(firebase("sh.paseo.plusplus"));
  assert.throws(
    () => requireFirebasePackage(firebase("sh.paseo")),
    /Firebase configuration must include sh\.paseo\.plusplus/,
  );
  assert.throws(() => requireFirebasePackage({}), /must include sh\.paseo\.plusplus/);
});

test("writes the keystore bytes and Firebase file with owner-only permissions", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "paseo-android-signing-files-"));
  try {
    const env = {
      GOOGLE_SERVICES_JSON: JSON.stringify(firebase("sh.paseo.plusplus")),
      KEYSTORE_BASE64: Buffer.from("keystore bytes").toString("base64"),
      PASEO_ANDROID_KEYSTORE: path.join(directory, "preview.keystore"),
      GOOGLE_SERVICES_FILE_PREVIEW: path.join(directory, "google-services.preview.json"),
    };
    writeAndroidSigningFiles(env);

    assert.equal(readFileSync(env.PASEO_ANDROID_KEYSTORE, "utf8"), "keystore bytes");
    assert.deepEqual(
      JSON.parse(readFileSync(env.GOOGLE_SERVICES_FILE_PREVIEW, "utf8")),
      firebase("sh.paseo.plusplus"),
    );
    if (process.platform !== "win32") {
      assert.equal(statSync(env.PASEO_ANDROID_KEYSTORE).mode & 0o777, 0o600);
      assert.equal(statSync(env.GOOGLE_SERVICES_FILE_PREVIEW).mode & 0o777, 0o600);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("writes no signing file when the Firebase package is wrong", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "paseo-android-signing-files-"));
  try {
    const env = {
      GOOGLE_SERVICES_JSON: JSON.stringify(firebase("sh.paseo")),
      KEYSTORE_BASE64: "",
      PASEO_ANDROID_KEYSTORE: path.join(directory, "preview.keystore"),
      GOOGLE_SERVICES_FILE_PREVIEW: path.join(directory, "google-services.preview.json"),
    };
    assert.throws(() => writeAndroidSigningFiles(env), /must include sh\.paseo\.plusplus/);
    assert.equal(existsSync(env.PASEO_ANDROID_KEYSTORE), false);
    assert.equal(existsSync(env.GOOGLE_SERVICES_FILE_PREVIEW), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
