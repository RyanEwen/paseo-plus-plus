package sh.paseo.ssh

/**
 * One destination's imported secrets. Not a data class: a generated toString would print the
 * private key into logs or crash reports.
 */
internal class SshCredentials(
  val privateKey: String,
  val passphrase: String,
  val fingerprint: String,
) {
  override fun toString() = "SshCredentials(fingerprint=$fingerprint)"
}
