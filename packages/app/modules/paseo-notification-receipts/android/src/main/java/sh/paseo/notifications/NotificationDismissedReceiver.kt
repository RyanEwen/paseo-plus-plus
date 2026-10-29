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

/** A fixed-event outbox, never a credential store or a notification-listener service. */
internal object NotificationDismissals {
  val listeners = CopyOnWriteArraySet<() -> Unit>()
  private fun preferences(context: Context) = context.getSharedPreferences("paseo-notification-dismissals", Context.MODE_PRIVATE)

  @Synchronized
  fun record(context: Context, content: String) {
    require(content.length <= 8192) { "Invalid notification data" }
    val input = JSONObject(content)
    val server = input.optString("serverId")
    val workspace = input.optString("workspaceId")
    val sequence = input.optDouble("notificationSequence", Double.NaN)
    require(server.isNotBlank() && server.length <= 256 && workspace.isNotBlank() && workspace.length <= 256)
    require(sequence.isFinite() && sequence >= 1 && sequence <= 9007199254740991.0 && sequence == sequence.toLong().toDouble())
    val data = JSONObject().put("serverId", server).put("workspaceId", workspace).put("notificationSequence", sequence.toLong())
    val agent = input.optString("agentId")
    val timestamp = input.optString("attentionTimestamp")
    if (agent.isNotBlank() && agent.length <= 256 && timestamp.isNotBlank() && timestamp.length <= 64) {
      data.put("agentId", agent).put("attentionTimestamp", timestamp)
    }
    val id = UUID.nameUUIDFromBytes(data.toString().toByteArray(Charsets.UTF_8)).toString()
    val current = JSONArray(preferences(context).getString("pending", "[]"))
    if ((0 until current.length()).any { current.getJSONObject(it).getString("id") == id }) return
    current.put(JSONObject().put("id", id).put("data", data))
    check(preferences(context).edit().putString("pending", current.toString()).commit())
    listeners.forEach { it() }
  }

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
