import { i18n } from "@/i18n/i18next";

/** Failures the updater reports with translated copy from `androidUpdateErrors`. */
export type AndroidUpdateErrorKey =
  | "saveFailed"
  | "invalidChecksum"
  | "checksumMismatch"
  | "previewBuildsOnly"
  | "invalidApk"
  | "otherApp"
  | "versionMismatch"
  | "signingMismatch"
  | "insecureRedirect"
  | "invalidRedirect"
  | "timedOut"
  | "tooLarge"
  | "tooManyRedirects"
  | "invalidBuildNumber"
  | "unexpectedAssetUrl"
  | "missingApk"
  | "invalidChecksumInventory"
  | "rateLimited"
  | "requestFailed";

function translateUpdateError(key: string, params?: { status: number }): string {
  return i18n.t(`androidUpdateErrors.${key}`, params);
}

/** An updater failure whose message is already translated for display. */
export class AndroidUpdateError extends Error {
  constructor(
    readonly key: AndroidUpdateErrorKey,
    options: { status?: number; cause?: unknown } = {},
  ) {
    const params = options.status === undefined ? undefined : { status: options.status };
    super(translateUpdateError(key, params), { cause: options.cause });
    this.name = "AndroidUpdateError";
  }
}

// Keep in sync with AppUpdateErrorCode in AppUpdateException.kt.
const NATIVE_ERROR_KEYS: Record<string, AndroidUpdateErrorKey> = {
  ERR_UPDATE_SAVE_FAILED: "saveFailed",
  ERR_UPDATE_UNEXPECTED_URL: "unexpectedAssetUrl",
  ERR_UPDATE_INVALID_CHECKSUM: "invalidChecksum",
  ERR_UPDATE_CHECKSUM_MISMATCH: "checksumMismatch",
  ERR_UPDATE_PREVIEW_BUILDS_ONLY: "previewBuildsOnly",
  ERR_UPDATE_INVALID_APK: "invalidApk",
  ERR_UPDATE_OTHER_APP: "otherApp",
  ERR_UPDATE_VERSION_MISMATCH: "versionMismatch",
  ERR_UPDATE_SIGNING_MISMATCH: "signingMismatch",
  ERR_UPDATE_INSECURE_REDIRECT: "insecureRedirect",
  ERR_UPDATE_INVALID_REDIRECT: "invalidRedirect",
  ERR_UPDATE_TIMED_OUT: "timedOut",
  ERR_UPDATE_TOO_LARGE: "tooLarge",
  ERR_UPDATE_TOO_MANY_REDIRECTS: "tooManyRedirects",
};

const NATIVE_DOWNLOAD_HTTP_PATTERN = /^ERR_UPDATE_DOWNLOAD_HTTP_(\d+)$/;

/** Translated copy for a coded native rejection, or null for any other failure. */
function describeNativeFailure(code: string): string | null {
  const httpFailure = NATIVE_DOWNLOAD_HTTP_PATTERN.exec(code);
  if (httpFailure) {
    return translateUpdateError("downloadFailed", { status: Number(httpFailure[1]) });
  }
  const key = NATIVE_ERROR_KEYS[code];
  return key ? translateUpdateError(key) : null;
}

/**
 * The text to show for a failed check or install. Coded native rejections are translated here;
 * other errors keep their own message, and a non-Error value shows the fallback.
 */
export function describeUpdateFailure(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const nativeMessage = typeof error.code === "string" ? describeNativeFailure(error.code) : null;
    if (nativeMessage !== null) return nativeMessage;
  }
  return error instanceof Error ? error.message : fallback;
}
