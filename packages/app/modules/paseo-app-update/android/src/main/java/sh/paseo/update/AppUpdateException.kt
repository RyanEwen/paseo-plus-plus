package sh.paseo.update

import expo.modules.kotlin.exception.CodedException

/**
 * Stable error codes shared with `src/app-updates/errors.ts`.
 *
 * Expo prefixes every AsyncFunction rejection message but keeps the code. JavaScript maps these
 * codes to translated copy, so messages here are diagnostics only. Keep both lists in sync.
 */
internal object AppUpdateErrorCode {
  const val SAVE_FAILED = "ERR_UPDATE_SAVE_FAILED"
  const val UNEXPECTED_URL = "ERR_UPDATE_UNEXPECTED_URL"
  const val INVALID_CHECKSUM = "ERR_UPDATE_INVALID_CHECKSUM"
  const val CHECKSUM_MISMATCH = "ERR_UPDATE_CHECKSUM_MISMATCH"
  const val PREVIEW_BUILDS_ONLY = "ERR_UPDATE_PREVIEW_BUILDS_ONLY"
  const val INVALID_APK = "ERR_UPDATE_INVALID_APK"
  const val OTHER_APP = "ERR_UPDATE_OTHER_APP"
  const val VERSION_MISMATCH = "ERR_UPDATE_VERSION_MISMATCH"
  const val SIGNING_MISMATCH = "ERR_UPDATE_SIGNING_MISMATCH"
  const val INSECURE_REDIRECT = "ERR_UPDATE_INSECURE_REDIRECT"
  const val INVALID_REDIRECT = "ERR_UPDATE_INVALID_REDIRECT"
  const val TIMED_OUT = "ERR_UPDATE_TIMED_OUT"
  const val TOO_LARGE = "ERR_UPDATE_TOO_LARGE"
  const val TOO_MANY_REDIRECTS = "ERR_UPDATE_TOO_MANY_REDIRECTS"

  /** The HTTP status travels in the code because Expo's message prefix makes the text unreliable. */
  fun downloadFailed(status: Int) = "ERR_UPDATE_DOWNLOAD_HTTP_$status"
}

internal class AppUpdateException(code: String, message: String) : CodedException(code, message, null)

/** Reject the update with a coded failure unless [condition] holds. */
internal fun ensureUpdate(condition: Boolean, code: String, message: String) {
  if (!condition) throw AppUpdateException(code, message)
}
