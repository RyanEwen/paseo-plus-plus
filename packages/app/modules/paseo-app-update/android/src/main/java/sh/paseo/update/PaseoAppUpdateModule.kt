package sh.paseo.update

import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.core.content.FileProvider
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/** Download verified fork APKs off the UI thread, then hand installation to Android. */
class PaseoAppUpdateModule : Module() {
  private val context get() = requireNotNull(appContext.reactContext)
  private val updateFile get() = File(context.cacheDir, "app-updates/preview.apk")

  /** A preview APK asset on the fork's current or legacy repository, with a safe file name. */
  private val canonicalForkApkUrl = Regex(
    "https://github\\.com/RyanEwen/paseo(?:-plus-plus)?/releases/download/" +
      "v[0-9]+\\.[0-9]+\\.[0-9]+-preview\\.[0-9]+/" +
      "[A-Za-z0-9][A-Za-z0-9._-]*\\.apk"
  )
  private val sha256Pattern = Regex("[a-f0-9]{64}")

  override fun definition() = ModuleDefinition {
    Name("PaseoAppUpdate")
    Events("downloadProgress")

    Function("getVersionCode") { installedPackage().longVersionCode.toDouble() }

    AsyncFunction("download") { url: String, sha256: String, versionCode: Double ->
      requirePreviewPermission()
      requireTrustedDownloadRequest(url, sha256)
      updateFile.parentFile!!.mkdirs()
      val partial = File(updateFile.parentFile, "preview.partial")
      updateFile.delete()
      try {
        downloadApk(url, partial, versionCode)
        reportDownloadProgress(versionCode, partial.length(), partial.length(), "verifying")
        requireVerifiedDownload(partial, sha256, versionCode)
        ensureUpdate(partial.renameTo(updateFile), AppUpdateErrorCode.SAVE_FAILED, "Unable to save the downloaded update.")
      } finally {
        partial.delete()
      }
    }.runOnQueue(appContext.backgroundCoroutineScope)

    AsyncFunction("install") { versionCode: Double ->
      requirePreviewPermission()
      // Revalidate on every retry, including after returning from Android's permission screen.
      validateApk(updateFile, versionCode)
      if (!context.packageManager.canRequestPackageInstalls()) {
        val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
          Uri.parse("package:${context.packageName}"))
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        "permission_required"
      } else {
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.app-update", updateFile)
        val intent = Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        context.startActivity(intent)
        "installer_opened"
      }
    }.runOnQueue(appContext.backgroundCoroutineScope)
  }

  /**
   * Accept only a canonical fork APK URL and a well-formed SHA-256. The JavaScript release client
   * applies the same URL rule, but its input is untrusted here: this is the enforcing copy.
   */
  private fun requireTrustedDownloadRequest(url: String, sha256: String) {
    ensureUpdate(
      canonicalForkApkUrl.matches(url) && !url.contains(".."),
      AppUpdateErrorCode.UNEXPECTED_URL,
      "Unexpected update download URL."
    )
    ensureUpdate(sha256Pattern.matches(sha256), AppUpdateErrorCode.INVALID_CHECKSUM, "Invalid update checksum.")
  }

  /** Reject a downloaded file whose digest or package identity does not match the request. */
  private fun requireVerifiedDownload(file: File, sha256: String, versionCode: Double) {
    ensureUpdate(
      sha256Hex(file) == sha256,
      AppUpdateErrorCode.CHECKSUM_MISMATCH,
      "Update checksum mismatch. Try downloading again."
    )
    validateApk(file, versionCode)
  }

  /** Stream the file through SHA-256 and return the lowercase hex digest. */
  private fun sha256Hex(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
      val buffer = ByteArray(65536)
      while (true) {
        val count = input.read(buffer)
        if (count < 0) break
        digest.update(buffer, 0, count)
      }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
  }

  /** The install permission is injected only into fork previews, not store or F-Droid builds. */
  private fun requirePreviewPermission() {
    // This is an app-op permission. A runtime grant check would reject third-party installers.
    ensureUpdate(
      context.packageName == "sh.paseo.plusplus" &&
        installedPackage().requestedPermissions?.contains("android.permission.REQUEST_INSTALL_PACKAGES") == true,
      AppUpdateErrorCode.PREVIEW_BUILDS_ONLY,
      "App updates are available only in fork preview builds."
    )
  }

  @Suppress("DEPRECATION")
  private fun installedPackage(): PackageInfo = context.packageManager.getPackageInfo(
    context.packageName, PackageManager.GET_SIGNING_CERTIFICATES or PackageManager.GET_PERMISSIONS)

  /** Refuse downgrades, different app identities, and APKs signed with a different key. */
  @Suppress("DEPRECATION")
  private fun validateApk(file: File, versionCode: Double) {
    val archive = context.packageManager.getPackageArchiveInfo(file.absolutePath,
      PackageManager.GET_SIGNING_CERTIFICATES)
      ?: throw AppUpdateException(AppUpdateErrorCode.INVALID_APK, "The downloaded APK is invalid. Download it again.")
    val installed = installedPackage()
    ensureUpdate(archive.packageName == installed.packageName, AppUpdateErrorCode.OTHER_APP, "The update belongs to another app.")
    ensureUpdate(
      archive.longVersionCode.toDouble() == versionCode && archive.longVersionCode > installed.longVersionCode,
      AppUpdateErrorCode.VERSION_MISMATCH,
      "The update version does not match or is no longer newer."
    )
    val currentSigners = installed.signingInfo?.apkContentsSigners?.map { it.toCharsString() }?.sorted()
    val updateSigners = archive.signingInfo?.apkContentsSigners?.map { it.toCharsString() }?.sorted()
    ensureUpdate(
      !currentSigners.isNullOrEmpty() && currentSigners == updateSigners,
      AppUpdateErrorCode.SIGNING_MISMATCH,
      "The update signing key does not match this installation."
    )
  }

  /** Send bounded-rate byte progress without weakening checksum or installer approval gates. */
  private fun reportDownloadProgress(versionCode: Double, bytes: Long, total: Long?, phase: String) {
    sendEvent("downloadProgress", mapOf(
      "versionCode" to versionCode,
      "phase" to phase,
      "bytesDownloaded" to bytes.toDouble(),
      "totalBytes" to total?.toDouble()
    ))
  }

  /** Follow GitHub's HTTPS asset redirects with bounded time, size, and disk use. */
  private fun downloadApk(url: String, output: File, versionCode: Double) {
    var target = URL(url)
    val deadline = System.nanoTime() + 10L * 60 * 1_000_000_000
    repeat(6) {
      ensureUpdate(target.protocol == "https", AppUpdateErrorCode.INSECURE_REDIRECT, "Insecure update download redirect.")
      val connection = target.openConnection() as HttpURLConnection
      connection.connectTimeout = 30_000
      connection.readTimeout = 30_000
      connection.instanceFollowRedirects = false
      try {
        val status = connection.responseCode
        if (status in listOf(301, 302, 303, 307, 308)) {
          val location = connection.getHeaderField("Location")
            ?: throw AppUpdateException(AppUpdateErrorCode.INVALID_REDIRECT, "Invalid download redirect.")
          target = URL(target, location)
        } else {
          ensureUpdate(status == 200, AppUpdateErrorCode.downloadFailed(status), "Update download failed (HTTP $status).")
          var total = 0L
          val expectedBytes = connection.contentLengthLong.takeIf { it > 0 }
          var lastProgressAt = System.nanoTime()
          reportDownloadProgress(versionCode, total, expectedBytes, "downloading")
          connection.inputStream.use { input ->
            output.outputStream().use { destination ->
              val buffer = ByteArray(65536)
              while (true) {
                ensureUpdate(System.nanoTime() < deadline, AppUpdateErrorCode.TIMED_OUT, "Update download timed out. Try again.")
                val count = input.read(buffer)
                if (count < 0) break
                total += count
                ensureUpdate(total <= 512L * 1024 * 1024, AppUpdateErrorCode.TOO_LARGE, "Update APK exceeds the download limit.")
                destination.write(buffer, 0, count)
                val now = System.nanoTime()
                if (now - lastProgressAt >= 250_000_000L) {
                  reportDownloadProgress(versionCode, total, expectedBytes, "downloading")
                  lastProgressAt = now
                }
              }
            }
          }
          reportDownloadProgress(versionCode, total, expectedBytes, "downloading")
          return
        }
      } finally {
        connection.disconnect()
      }
    }
    throw AppUpdateException(AppUpdateErrorCode.TOO_MANY_REDIRECTS, "Too many update download redirects.")
  }
}
