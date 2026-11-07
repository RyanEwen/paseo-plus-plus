package sh.paseo.notifications

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.CopyOnWriteArraySet

/** Own-notification deleteIntent only. Persist before returning, even without a JS runtime. */
class NotificationDismissedReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val content = intent.getStringExtra("expo.notification.content") ?: return
    try {
      NotificationDismissals.record(context, content)
    } catch (error: Exception) {
      Log.e("PaseoNotifications", "Could not preserve notification dismissal", error)
    }
  }
}

/** Mirrors the routing caps the desktop and app receipt schemas apply to the same fields. */
private const val MAX_CONTENT_LENGTH = 8192
private const val MAX_ID_LENGTH = 256
private const val MAX_TIMESTAMP_LENGTH = 64

/** JavaScript's Number.MAX_SAFE_INTEGER, the largest sequence the receipt schema accepts. */
private const val MAX_SAFE_SEQUENCE = 9007199254740991.0

/** A fixed-event outbox, never a credential store or a notification-listener service. */
internal object NotificationDismissals {
  val listeners = CopyOnWriteArraySet<() -> Unit>()
  private fun preferences(context: Context) = context.getSharedPreferences("paseo-notification-dismissals", Context.MODE_PRIVATE)

  @Synchronized
  fun record(context: Context, content: String) {
    require(content.length <= MAX_CONTENT_LENGTH) { "Invalid notification data" }
    val input = JSONObject(content)
    val server = input.optString("serverId")
    val workspace = input.optString("workspaceId")
    val sequence = input.optDouble("notificationSequence", Double.NaN)
    require(isBoundedId(server)) { "Invalid notification server" }
    require(isBoundedId(workspace)) { "Invalid notification workspace" }
    require(sequence.isFinite()) { "Notification sequence is not a number" }
    require(sequence >= 1 && sequence <= MAX_SAFE_SEQUENCE) { "Notification sequence is out of range" }
    require(sequence == sequence.toLong().toDouble()) { "Notification sequence is not an integer" }
    val data = JSONObject()
      .put("serverId", server)
      .put("workspaceId", workspace)
      .put("notificationSequence", sequence.toLong())
    val agent = input.optString("agentId")
    val timestamp = input.optString("attentionTimestamp")
    val hasTimestamp = timestamp.isNotBlank() && timestamp.length <= MAX_TIMESTAMP_LENGTH
    if (isBoundedId(agent) && hasTimestamp) {
      data.put("agentId", agent).put("attentionTimestamp", timestamp)
    }
    val id = UUID.nameUUIDFromBytes(data.toString().toByteArray(Charsets.UTF_8)).toString()
    val current = JSONArray(preferences(context).getString("pending", "[]"))
    if ((0 until current.length()).any { current.getJSONObject(it).getString("id") == id }) return
    current.put(JSONObject().put("id", id).put("data", data))
    check(preferences(context).edit().putString("pending", current.toString()).commit())
    listeners.forEach { it() }
  }

  /** A present identifier within the shared routing length cap. */
  private fun isBoundedId(value: String): Boolean = value.isNotBlank() && value.length <= MAX_ID_LENGTH

  @Synchronized
  fun pending(context: Context): List<String> {
    val entries = JSONArray(preferences(context).getString("pending", "[]"))
    return (0 until entries.length()).map { entries.getJSONObject(it).toString() }
  }

  @Synchronized
  fun acknowledge(context: Context, ids: List<String>) {
    val removed = ids.toSet()
    val current = JSONArray(preferences(context).getString("pending", "[]"))
    val remaining = JSONArray()
    for (index in 0 until current.length()) {
      val entry = current.getJSONObject(index)
      if (!removed.contains(entry.getString("id"))) remaining.put(entry)
    }
    check(preferences(context).edit().putString("pending", remaining.toString()).commit())
  }
}
