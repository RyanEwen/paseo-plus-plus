package sh.paseo.ssh

import net.schmizz.sshj.SSHClient
import net.schmizz.sshj.userauth.keyprovider.KeyProvider
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.decodeBase64
import java.net.Proxy
import java.util.concurrent.TimeUnit

/**
 * Owns one tunnel and WebSocket. Closing during setup prevents late resources from escaping.
 *
 * @param expectedFingerprint the server fingerprint the user approved; any other key is rejected.
 * @param loadKey decodes the private key for authentication. The session drops it after the
 *   first authentication attempt, so it does not keep key material for its lifetime.
 */
internal class SshSession(
  private val id: String,
  private val target: SshTarget,
  private val expectedFingerprint: String,
  loadKey: (SSHClient) -> KeyProvider,
  private val emit: (Map<String, Any?>) -> Unit,
  private val onClosed: () -> Unit,
) {
  private val ssh = createSshClient()
  private val http = OkHttpClient.Builder()
    .connectTimeout(10, TimeUnit.SECONDS)
    .readTimeout(0, TimeUnit.MILLISECONDS)
    .pingInterval(20, TimeUnit.SECONDS)
    .proxy(Proxy.NO_PROXY)
    .socketFactory(SshChannelSocketFactory(ssh, target.daemonPort))
    .build()
  @Volatile private var loadKey: ((SSHClient) -> KeyProvider)? = loadKey
  private var socket: WebSocket? = null
  @Volatile private var closed = false
  @Volatile private var fingerprintChanged = false

  fun open() {
    try {
      ssh.addHostKeyVerifier(verifier { actual ->
        if (actual != expectedFingerprint) {
          fingerprintChanged = true
          return@verifier false
        }
        true
      })
      if (closed) return

      // SSHJ starts its keepalive thread during connect, only when the interval is already set.
      ssh.connection.keepAlive.keepAliveInterval = 15
      ssh.connect(target.hostname, target.sshPort)
      if (closed) return
      authenticate()

      synchronized(this) {
        if (closed) return
        val request = Request.Builder().url("http://127.0.0.1:${target.daemonPort}/ws").build()
        socket = http.newWebSocket(request, DaemonSocketListener())
      }
    } catch (error: Exception) {
      // Library exceptions can contain key material; emit only a controlled error to JS.
      fail(failureMessage())
    } finally {
      if (closed) runCatching { ssh.close() }
    }
  }

  /** Authenticate with the imported key, then forget how to load it. */
  private fun authenticate() {
    val load = requireNotNull(loadKey) { "SSH session was already authenticated." }
    try {
      ssh.authPublickey(target.username, load(ssh))
    } finally {
      loadKey = null
    }
  }

  private fun failureMessage(): String {
    if (fingerprintChanged) {
      return "SSH server fingerprint changed. Remove and re-add the connection after verifying the server."
    }
    return "SSH connection failed. Check the host, private key, passphrase, and remote daemon."
  }

  /** Forwards one WebSocket's lifecycle to the JavaScript bridge as transport events. */
  private inner class DaemonSocketListener : WebSocketListener() {
    override fun onOpen(webSocket: WebSocket, response: Response) {
      event("open")
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
      event("message", mapOf("text" to text))
    }

    override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
      event("message", mapOf("binaryBase64" to bytes.base64()))
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
      webSocket.close(code, reason)
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
      finish(code, reason)
    }

    override fun onFailure(webSocket: WebSocket, error: Throwable, response: Response?) {
      fail("Unable to connect to the remote Paseo daemon.")
    }
  }

  /** Send one text frame, or one base64-encoded binary frame when `text` is null. */
  @Synchronized fun send(text: String?, binary: String?) {
    check(!closed) { "SSH connection is closed." }
    val accepted = if (text != null) {
      socket?.send(text)
    } else {
      val bytes = (binary ?: "").decodeBase64() ?: error("Invalid binary message.")
      socket?.send(bytes)
    }
    check(accepted == true) { "Unable to send over SSH." }
  }

  @Synchronized private fun event(kind: String, data: Map<String, Any?> = emptyMap()) {
    if (!closed) emit(mapOf("sessionId" to id, "kind" to kind) + data)
  }

  private fun fail(message: String) {
    event("error", mapOf("error" to message))
    finish(1006, message)
  }

  @Synchronized private fun finish(code: Int, reason: String) {
    if (closed) return
    event("close", mapOf("code" to code, "reason" to reason))
    close()
  }

  @Synchronized fun close() {
    if (closed) return
    closed = true
    loadKey = null
    try {
      // Channel.close waits for the peer. Break transport I/O before cancelling OkHttp's channel.
      runCatching { ssh.socket?.close() }
      runCatching { ssh.close() }
      runCatching { socket?.cancel() }
    } finally {
      http.dispatcher.executorService.shutdown()
      http.connectionPool.evictAll()
      onClosed()
    }
  }
}
