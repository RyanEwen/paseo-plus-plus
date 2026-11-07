package sh.paseo.ssh

import expo.modules.kotlin.exception.CodedException

/**
 * Stable error codes shared with `hosts/ssh/ssh-native-bridge.ts`.
 *
 * Expo prefixes every AsyncFunction rejection message with "Call to function ... has been
 * rejected", but keeps the code. JavaScript maps these codes to user-facing copy, so the
 * messages below are diagnostics only. Keep both lists in sync.
 */
internal object SshErrorCode {
  const val INVALID_TARGET = "ERR_SSH_INVALID_TARGET"
  const val KEY_TOO_LARGE = "ERR_SSH_KEY_TOO_LARGE"
  const val KEY_UNREADABLE = "ERR_SSH_KEY_UNREADABLE"
  const val UNREACHABLE = "ERR_SSH_UNREACHABLE"
  const val INVALID_CREDENTIALS = "ERR_SSH_INVALID_CREDENTIALS"
  const val IMPORT_EXPIRED = "ERR_SSH_IMPORT_EXPIRED"
  const val KEY_MISSING = "ERR_SSH_KEY_MISSING"
  const val SESSION_CLOSED = "ERR_SSH_SESSION_CLOSED"
}

/** A controlled bridge failure. Never wrap a library exception: its text can carry key material. */
internal class SshException(code: String, message: String) : CodedException(code, message, null)
