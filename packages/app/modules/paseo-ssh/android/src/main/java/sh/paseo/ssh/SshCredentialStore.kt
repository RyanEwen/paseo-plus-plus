package sh.paseo.ssh

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import android.util.Base64
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Encrypts SSH secrets with a non-exportable Android Keystore key in backup-excluded storage. */
internal class SshCredentialStore(context: Context) {
  private val directory = File(context.noBackupFilesDir, "paseo-ssh").apply { mkdirs() }
  private val alias = "paseo-ssh-credentials-v1"

  /** Load the Keystore key, creating it on first use. */
  private fun key(): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    val existing = store.getKey(alias, null) as? SecretKey
    if (existing != null) return existing

    val spec = KeyGenParameterSpec.Builder(
      alias,
      KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
    )
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .build()
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    generator.init(spec)
    return generator.generateKey()
  }

  /** File names hash the credential id, so destinations never appear on disk. */
  private fun file(id: String): File {
    val digest = MessageDigest.getInstance("SHA-256").digest(id.toByteArray())
    val name = digest.joinToString("") { "%02x".format(it) }
    return File(directory, name)
  }

  @Synchronized fun save(id: String, credentials: SshCredentials) {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, key())
    // Bind the ciphertext to its id, so one destination's file cannot stand in for another's.
    cipher.updateAAD(id.toByteArray())
    val encrypted = cipher.doFinal(toJson(credentials).toString().toByteArray())

    val envelope = JSONObject()
    envelope.put("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
    envelope.put("data", Base64.encodeToString(encrypted, Base64.NO_WRAP))

    val atomic = AtomicFile(file(id))
    val stream = atomic.startWrite()
    try {
      stream.write(envelope.toString().toByteArray())
      atomic.finishWrite(stream)
    } catch (error: Exception) {
      atomic.failWrite(stream)
      throw error
    }
  }

  @Synchronized fun read(id: String): SshCredentials? {
    val target = file(id)
    if (!target.exists()) return null

    val stored = AtomicFile(target).openRead().use { it.readBytes().toString(Charsets.UTF_8) }
    val envelope = JSONObject(stored)
    val iv = Base64.decode(envelope.getString("iv"), Base64.NO_WRAP)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
    cipher.updateAAD(id.toByteArray())
    val decrypted = cipher.doFinal(Base64.decode(envelope.getString("data"), Base64.NO_WRAP))
    return fromJson(JSONObject(decrypted.toString(Charsets.UTF_8)))
  }

  @Synchronized fun remove(id: String) {
    AtomicFile(file(id)).delete()
  }

  // The stored JSON keys are a persisted format: files written by earlier builds use them.
  private fun toJson(credentials: SshCredentials): JSONObject {
    val json = JSONObject()
    json.put("privateKey", credentials.privateKey)
    json.put("passphrase", credentials.passphrase)
    json.put("fingerprint", credentials.fingerprint)
    return json
  }

  private fun fromJson(json: JSONObject) = SshCredentials(
    privateKey = json.getString("privateKey"),
    passphrase = json.optString("passphrase"),
    fingerprint = json.getString("fingerprint"),
  )
}
