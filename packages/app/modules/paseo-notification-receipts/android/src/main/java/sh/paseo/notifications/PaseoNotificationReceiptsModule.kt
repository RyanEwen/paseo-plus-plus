package sh.paseo.notifications

import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** Expose durable own-notification swipe receipts; no background network or OS-wide access. */
class PaseoNotificationReceiptsModule : Module() {
  private val listener: () -> Unit = {
    Handler(Looper.getMainLooper()).post { sendEvent("dismissalsChanged", emptyMap<String, Any>()) }
  }

  override fun definition() = ModuleDefinition {
    Name("PaseoNotificationReceipts")
    Events("dismissalsChanged")
    OnCreate { NotificationDismissals.listeners.add(listener) }
    OnDestroy { NotificationDismissals.listeners.remove(listener) }
    AsyncFunction("pending") { NotificationDismissals.pending(requireNotNull(appContext.reactContext)) }
    AsyncFunction("acknowledge") { ids: List<String> -> NotificationDismissals.acknowledge(requireNotNull(appContext.reactContext), ids) }
  }
}
