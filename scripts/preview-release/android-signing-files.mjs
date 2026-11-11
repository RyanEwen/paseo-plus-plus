import { writeFileSync } from "node:fs";
import { isMainModule } from "../is-main-module.mjs";
import { PREVIEW_ANDROID_PACKAGE } from "./android-signer.mjs";

/** Throw unless the Firebase configuration registers an Android client for `packageName`. */
export function requireFirebasePackage(google, packageName = PREVIEW_ANDROID_PACKAGE) {
  const registered = google.client?.some(
    (client) => client.client_info?.android_client_info?.package_name === packageName,
  );
  if (!registered) {
    throw new Error(`Firebase configuration must include ${packageName}`);
  }
}

/**
 * Write the ephemeral preview keystore and Firebase configuration with owner-only permissions.
 * Reads GOOGLE_SERVICES_JSON, KEYSTORE_BASE64 and the two destination paths
 * (PASEO_ANDROID_KEYSTORE, GOOGLE_SERVICES_FILE_PREVIEW) from `env`. Validates the Firebase
 * package before writing either file.
 */
export function writeAndroidSigningFiles(env) {
  const google = JSON.parse(env.GOOGLE_SERVICES_JSON);
  requireFirebasePackage(google);
  writeFileSync(env.PASEO_ANDROID_KEYSTORE, Buffer.from(env.KEYSTORE_BASE64, "base64"), {
    mode: 0o600,
  });
  writeFileSync(env.GOOGLE_SERVICES_FILE_PREVIEW, JSON.stringify(google), { mode: 0o600 });
}

if (isMainModule(import.meta.url)) {
  writeAndroidSigningFiles(process.env);
}
