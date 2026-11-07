import { readFileSync } from "node:fs";
import { isMainModule } from "../is-main-module.mjs";

/** The fork preview's Android package name. */
export const PREVIEW_ANDROID_PACKAGE = "sh.paseo.plusplus";
/** Native ABIs every preview APK must ship, sorted. */
export const PREVIEW_ANDROID_ABIS = ["arm64-v8a", "armeabi-v7a", "x86", "x86_64"];

/** Require one app signer matching the preview key; distribution stamps are separate identities. */
export function verifyAndroidApkSigner(report, expectedCertificate) {
  const expected = expectedCertificate.replaceAll(":", "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expected)) {
    throw new Error("Expected preview certificate must be a SHA-256 fingerprint");
  }

  // apksigner labels app certificates by number, SDK range, or signature scheme.
  // Anchor whole lines so a Source Stamp Signer cannot satisfy the app identity gate.
  const certificates = [
    ...report
      .replaceAll("\r\n", "\n")
      .matchAll(
        /^(?:Signer #\d+|Signer \(minSdkVersion=[^\r\n]+\)|V[1-4](?:\.\d+)? Signer:) certificate SHA-256 digest:[ \t]*([a-fA-F0-9:]+)[ \t]*$/gm,
      ),
  ];
  if (certificates.length !== 1) {
    throw new Error(`Expected exactly one APK app signer, found ${certificates.length}`);
  }
  const actual = certificates[0][1].replaceAll(":", "").toLowerCase();
  if (actual !== expected) {
    throw new Error(`APK app signer does not match the preview certificate: ${actual}`);
  }
  return actual;
}

/**
 * Require the preview package name, exactly the supported native ABIs, and the release's Android
 * version code in a built APK.
 * `badging` is `aapt dump badging` output; `entries` lists the APK's file paths, one per line.
 */
export function verifyAndroidApkIdentity({ badging, entries, expectedVersionCode }) {
  if (!badging.includes(`package: name='${PREVIEW_ANDROID_PACKAGE}'`)) {
    throw new Error(`APK package is not ${PREVIEW_ANDROID_PACKAGE}`);
  }

  const abis = [
    ...new Set(
      entries
        .split(/\r?\n/)
        .map((entry) => entry.split("/"))
        .filter((parts) => parts[0] === "lib")
        .map((parts) => parts[1] ?? ""),
    ),
  ].sort();
  if (JSON.stringify(abis) !== JSON.stringify(PREVIEW_ANDROID_ABIS)) {
    throw new Error(`Unexpected APK ABIs: ${abis.join(", ")}`);
  }

  if (!badging.includes(`versionCode='${expectedVersionCode}'`)) {
    throw new Error(`APK version code is not the release's ${expectedVersionCode}`);
  }
}

if (isMainModule(import.meta.url) && process.argv[2] === "--identity") {
  const [badgingPath, entriesPath, releasePath] = process.argv.slice(3);
  if (!badgingPath || !entriesPath || !releasePath) {
    throw new Error(
      "Usage: node android-signer.mjs --identity <aapt-badging> <apk-entries> <preview-release.json>",
    );
  }
  verifyAndroidApkIdentity({
    badging: readFileSync(badgingPath, "utf8"),
    entries: readFileSync(entriesPath, "utf8"),
    expectedVersionCode: JSON.parse(readFileSync(releasePath, "utf8")).androidVersionCode,
  });
  console.log("Verified APK package, native ABIs and version code");
} else if (isMainModule(import.meta.url)) {
  const [reportPath, expectedCertificate] = process.argv.slice(2);
  if (!reportPath || !expectedCertificate) {
    throw new Error(
      "Usage: node android-signer.mjs <apksigner-report> <expected-certificate-sha256>",
    );
  }
  const certificate = verifyAndroidApkSigner(readFileSync(reportPath, "utf8"), expectedCertificate);
  console.log(`Verified APK app signer: ${certificate}`);
}
