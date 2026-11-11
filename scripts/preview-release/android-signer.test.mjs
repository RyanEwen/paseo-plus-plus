import assert from "node:assert/strict";
import { test } from "vitest";
import { verifyAndroidApkIdentity, verifyAndroidApkSigner } from "./android-signer.mjs";

test("Android signer proof accepts SDK labels and rejects stamps or another signing identity", () => {
  const certificate = "ab".repeat(32);
  const other = "cd".repeat(32);
  for (const label of [
    "Signer #1",
    "Signer (minSdkVersion=33, maxSdkVersion=2147483647)",
    "V3.0 Signer:",
  ]) {
    const app = `${label} certificate SHA-256 digest: ${certificate}`;
    const stamp = `Source Stamp Signer: certificate SHA-256 digest: ${other}`;
    assert.equal(verifyAndroidApkSigner(`${app}\r\n${stamp}\r\n`, certificate), certificate);
    assert.throws(
      () => verifyAndroidApkSigner(app.replace(certificate, other), certificate),
      /does not match/,
    );
    assert.throws(
      () => verifyAndroidApkSigner(`${stamp}\n${app}\n${app}`, certificate),
      /exactly one/,
    );
  }
  assert.throws(
    () =>
      verifyAndroidApkSigner(
        `Source Stamp Signer: certificate SHA-256 digest: ${certificate}`,
        certificate,
      ),
    /exactly one/,
  );
  assert.throws(
    () =>
      verifyAndroidApkSigner(
        `Signer #1 certificate SHA-256 digest: ${certificate}\nSigner #2 certificate SHA-256 digest: ${other}`,
        certificate,
      ),
    /exactly one/,
  );
  assert.throws(
    () =>
      verifyAndroidApkSigner(
        `prefix Signer #1 certificate SHA-256 digest: ${certificate}`,
        certificate,
      ),
    /exactly one/,
  );
  assert.throws(
    () => verifyAndroidApkSigner(`Signer #1 certificate SHA-256 digest: ab`, certificate),
    /does not match/,
  );
  assert.throws(() => verifyAndroidApkSigner("", "ab"), /SHA-256 fingerprint/);
});

test("APK identity requires the preview package, all four ABIs and the release version code", () => {
  const badging =
    "package: name='sh.paseo.plusplus' versionCode='1000000043' versionName='0.15.3'\nsdkVersion:'24'\n";
  const entries = [
    "AndroidManifest.xml",
    "lib/arm64-v8a/libhermes.so",
    "lib/armeabi-v7a/libhermes.so",
    "lib/x86/libhermes.so",
    "lib/x86_64/libhermes.so",
    "lib/x86_64/libc++_shared.so",
    "assets/index.android.bundle",
    "",
  ].join("\n");
  verifyAndroidApkIdentity({ badging, entries, expectedVersionCode: 1_000_000_043 });

  assert.throws(
    () =>
      verifyAndroidApkIdentity({
        badging: badging.replace("sh.paseo.plusplus", "sh.paseo"),
        entries,
        expectedVersionCode: 1_000_000_043,
      }),
    /APK package is not sh\.paseo\.plusplus/,
  );
  assert.throws(
    () =>
      verifyAndroidApkIdentity({
        badging,
        entries: entries.replace("lib/x86/libhermes.so\n", ""),
        expectedVersionCode: 1_000_000_043,
      }),
    /Unexpected APK ABIs: arm64-v8a, armeabi-v7a, x86_64/,
  );
  assert.throws(
    () => verifyAndroidApkIdentity({ badging, entries, expectedVersionCode: 1_000_000_044 }),
    /version code is not the release's 1000000044/,
  );
});
