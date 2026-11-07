import { isMainModule } from "../is-main-module.mjs";

/**
 * Every credential and project setting a full preview release needs, as the workflow passes them
 * through the environment. Checked once up front so a release fails before any build starts.
 */
export const PREVIEW_CREDENTIAL_NAMES = [
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "PASEO_AZURE_PUBLISHER_NAME",
  "PASEO_AZURE_SIGNING_ENDPOINT",
  "PASEO_AZURE_CERTIFICATE_PROFILE",
  "PASEO_AZURE_SIGNING_ACCOUNT",
  "KEYSTORE",
  "KEYSTORE_PASSWORD",
  "KEY_ALIAS",
  "KEY_PASSWORD",
  "GOOGLE_SERVICES",
  "PASEO_PREVIEW_EXPO_PROJECT_ID",
  "PASEO_PREVIEW_EXPO_OWNER",
  "PASEO_PREVIEW_EXPO_SLUG",
];

/** Throw, naming every missing or blank credential, unless all are present in `env`. */
export function requirePreviewCredentials(env) {
  const missing = PREVIEW_CREDENTIAL_NAMES.filter((name) => !env[name]?.trim());
  if (missing.length) {
    throw new Error(`Missing preview credentials: ${missing.join(", ")}`);
  }
}

if (isMainModule(import.meta.url)) {
  requirePreviewCredentials(process.env);
}
