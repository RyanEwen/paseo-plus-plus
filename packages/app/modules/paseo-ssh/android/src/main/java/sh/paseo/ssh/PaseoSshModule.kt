package sh.paseo.ssh

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val MAX_PRIVATE_KEY_LENGTH = 65536

/** Android SSH bridge. Only approved keys are staged; durable storage follows a successful daemon probe. */
class PaseoSshModule : Module() {
  private val lifecycle = SshModuleLifecycle<SshSession> { it.close() }
  private val staged = mutableMapOf<String, SshCredentials>()
  private val store by lazy { SshCredentialStore(requireNotNull(appContext.reactContext)) }

  override fun definition() = ModuleDefinition {
    Name("PaseoSsh")
    Events("transportEvent")

    AsyncFunction("inspect") { targetInput: Map<String, Any?>, privateKey: String, passphrase: String ->
      inspect(SshTarget.from(targetInput), privateKey, passphrase)
    }.runOnQueue(appContext.backgroundCoroutineScope)

    AsyncFunction("stage") { id: String, targetInput: Map<String, Any?>, privateKey: String, passphrase: String, fingerprint: String ->
      SshTarget.from(targetInput)
      val isBoundedKey = privateKey.length in 1..MAX_PRIVATE_KEY_LENGTH
      val isSha256Fingerprint = fingerprint.startsWith("SHA256:")
      if (!isBoundedKey || !isSha256Fingerprint) {
        throw SshException(SshErrorCode.INVALID_CREDENTIALS, "Invalid SSH credentials.")
      }
      val credentials = SshCredentials(privateKey, passphrase, fingerprint)
      lifecycle.withActive {
        staged[id] = credentials
      }
    }

    AsyncFunction("commit") { id: String ->
      lifecycle.withActive {
        val credentials = staged[id]
          ?: throw SshException(SshErrorCode.IMPORT_EXPIRED, "SSH key import expired. Import the key again.")
        store.save(id, credentials)
        staged.remove(id)
        Unit
      }
    }.runOnQueue(appContext.backgroundCoroutineScope)

    AsyncFunction("discard") { id: String ->
      lifecycle.withActive {
        staged.remove(id)
        Unit
      }
    }

    AsyncFunction("remove") { id: String ->
      lifecycle.withActive {
        staged.remove(id)
        store.remove(id)
      }
    }.runOnQueue(appContext.backgroundCoroutineScope)

    AsyncFunction("open") { id: String, credentialId: String, targetInput: Map<String, Any?> ->
      open(id, credentialId, SshTarget.from(targetInput))
    }.runOnQueue(appContext.backgroundCoroutineScope)

    AsyncFunction("send") { id: String, text: String?, binary: String? ->
      val session = lifecycle.get(id)
        ?: throw SshException(SshErrorCode.SESSION_CLOSED, "SSH session is closed.")
      session.send(text, binary)
    }

    AsyncFunction("close") { id: String ->
      lifecycle.remove(id)?.close()
      Unit
    }.runOnQueue(appContext.backgroundCoroutineScope)

    OnDestroy {
      lifecycle.destroy { staged.clear() }
    }
  }

  /** Read the server's fingerprint without logging in. Returns it for the user to approve. */
  private fun inspect(target: SshTarget, privateKey: String, passphrase: String): String {
    if (privateKey.length !in 1..MAX_PRIVATE_KEY_LENGTH) {
      throw SshException(SshErrorCode.KEY_TOO_LARGE, "Choose a private key smaller than 64 KiB.")
    }
    val client = createSshClient()
    try {
      try {
        loadPrivateKey(client, privateKey, passphrase)
      } catch (error: Exception) {
        throw SshException(
          SshErrorCode.KEY_UNREADABLE,
          "Unable to read the private key. Check its format and passphrase.",
        )
      }

      var observed: String? = null
      // Discovery rejects the handshake. No SSH login or key signature occurs before approval.
      client.addHostKeyVerifier(verifier { fingerprint ->
        observed = fingerprint
        false
      })
      runCatching { client.connect(target.hostname, target.sshPort) }
      return observed
        ?: throw SshException(SshErrorCode.UNREACHABLE, "Unable to reach the SSH server. Check the hostname and port.")
    } finally {
      client.close()
    }
  }

  /** Start a tunnel for `id`, preferring credentials staged by an in-progress import. */
  private fun open(id: String, credentialId: String, target: SshTarget) {
    val stagedCredentials = lifecycle.withActive { staged[credentialId] }
    val credentials = stagedCredentials
      ?: store.read(credentialId)
      ?: throw SshException(SshErrorCode.KEY_MISSING, "Import a private key for this SSH host on this device.")

    lateinit var session: SshSession
    session = SshSession(
      id = id,
      target = target,
      expectedFingerprint = credentials.fingerprint,
      loadKey = { client -> loadPrivateKey(client, credentials.privateKey, credentials.passphrase) },
      emit = { event -> sendEvent("transportEvent", event) },
      onClosed = { lifecycle.remove(id, session) },
    )
    // Credential loading and construction can outlive teardown. Registration fences both.
    lifecycle.registerAndStart(id, session) {
      val connect = Thread({ session.open() }, "paseo-ssh-connect")
      connect.isDaemon = true
      connect.start()
    }
  }
}
