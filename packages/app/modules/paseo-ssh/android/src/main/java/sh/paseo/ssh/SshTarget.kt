package sh.paseo.ssh

import net.schmizz.sshj.SSHClient
import net.schmizz.sshj.common.Buffer
import net.schmizz.sshj.common.SecurityUtils
import net.schmizz.sshj.transport.verification.HostKeyVerifier
import net.schmizz.sshj.userauth.keyprovider.KeyProvider
import net.schmizz.sshj.userauth.password.PasswordUtils
import org.bouncycastle.jce.provider.BouncyCastleProvider
import java.security.MessageDigest
import java.security.Provider
import java.security.PublicKey
import java.security.Security
import java.util.Base64

private const val DEFAULT_SSH_PORT = 22
private const val DEFAULT_DAEMON_PORT = 6767
private val VALID_PORTS = 1..65535

/** Explicit destinations only: Android has no access to the desktop's SSH config or agent. */
internal data class SshTarget(val host: String, val sshPort: Int, val daemonPort: Int) {
  val username: String get() = host.substringBeforeLast('@')
  val hostname: String get() = host.substringAfterLast('@')

  init {
    val hasExplicitUsername = host.contains('@') && username.isNotBlank()
    val hasHostname = hostname.isNotBlank()
    val hasWhitespace = host.any { it.isWhitespace() }
    // A leading dash could be read as an option by tools that receive the hostname.
    val looksLikeOption = hostname.startsWith("-")
    if (!hasExplicitUsername || !hasHostname || hasWhitespace || looksLikeOption) {
      throw SshException(
        SshErrorCode.INVALID_TARGET,
        "Enter ssh://user@hostname with an explicit username.",
      )
    }
    if (sshPort !in VALID_PORTS || daemonPort !in VALID_PORTS) {
      throw SshException(SshErrorCode.INVALID_TARGET, "Invalid SSH or daemon port.")
    }
  }

  companion object {
    /** Read the destination the JavaScript bridge sends; omitted ports use the defaults. */
    fun from(value: Map<String, Any?>): SshTarget {
      val host = value["host"] as String
      val sshPort = (value["sshPort"] as? Number)?.toInt() ?: DEFAULT_SSH_PORT
      val daemonPort = (value["daemonPort"] as? Number)?.toInt() ?: DEFAULT_DAEMON_PORT
      return SshTarget(host, sshPort, daemonPort)
    }
  }
}

/** Hash the SSH wire encoding, rather than the Java X.509 public-key encoding. */
internal fun fingerprint(key: PublicKey): String {
  val wire = Buffer.PlainBuffer().putPublicKey(key).compactData
  val digest = MessageDigest.getInstance("SHA-256").digest(wire)
  return "SHA256:" + Base64.getEncoder().withoutPadding().encodeToString(digest)
}

internal fun verifier(check: (String) -> Boolean) = object : HostKeyVerifier {
  override fun verify(hostname: String, port: Int, key: PublicKey) = check(fingerprint(key))
  override fun findExistingAlgorithms(hostname: String, port: Int): List<String> = emptyList()
}

/** Forces lazy key decoding now, so a bad key or passphrase fails in the import form. */
internal fun loadPrivateKey(client: SSHClient, privateKey: String, passphrase: String): KeyProvider {
  val password = PasswordUtils.createOneOff(passphrase.toCharArray())
  val provider = client.loadKeys(privateKey, null, password)
  provider.private
  return provider
}

/** Keep full SSH crypto separate from Android's stripped BC provider without replacing platform providers. */
@Synchronized internal fun createSshClient(): SSHClient {
  val providerName = "PaseoSSH"
  if (Security.getProvider(providerName) == null) {
    val provider = object : Provider(providerName, 1.0, "Paseo SSH cryptography") {}
    BouncyCastleProvider().entries
      .filter { !(it.key as String).startsWith("Provider.id ") }
      .forEach { provider[it.key] = it.value }
    Security.addProvider(provider)
  }
  SecurityUtils.setSecurityProvider(providerName)
  return SSHClient().apply {
    connectTimeout = 10000
    timeout = 10000
  }
}
