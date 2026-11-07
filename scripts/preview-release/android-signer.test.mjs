import assert from "node:assert/strict";
import { test } from "vitest";
import { verifyAndroidApkSigner } from "./android-signer.mjs";

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
