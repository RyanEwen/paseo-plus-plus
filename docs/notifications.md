# Notifications

Use `notification-open` for OS notification taps. It owns delivery, parsing,
process-local deduplication, startup readiness, and native acknowledgement.
Keep agent and workspace navigation in their existing navigation modules.
Import the pure API from `@/notification-open` and the app-shell component from
`@/notification-open/react`; senders must not load the React routing runtime.

Agent payloads name a host and agent. Ignore their workspace hint when opening:
the agent can move after a notification is sent. Use `navigateToAgent`, which
uses the current store record or the agent route to resolve the workspace from
the host. Terminal payloads name their workspace and use `navigateToWorkspace`.

See [agent targets and deferred opens](expo-router.md#agent-targets) for route
ownership and workspace recovery. Notification generation, presence, and push
eligibility remain daemon concerns.

## Native delivery

Keep the router instance at module scope. Android's `singleTask` Activity can
finish on Back while its JS context remains alive. A React ref is lost when the
root remounts; process-local handled IDs must survive that remount.

Clear `lastNotificationResponse` after dispatch. Reading a launch response does
not acknowledge it. Without clearing it, a later Activity launch can reopen the
old agent.

With expo-notifications 57, Android also replays its pending response list to
new native listeners. Clearing the last response does not drain that list.
Deduplication covers listener registration within one JS context. A development
JS reload creates another context and can replay a cold-launch response; do not
add persisted handled IDs to compensate. Recheck this limitation when upgrading
expo-notifications.

iOS drains pending responses when its delegate first handles them. Push data
read by Expo arrives under `userInfo.body`; simulator payloads must match:

```json
{
  "aps": { "alert": { "title": "Agent finished", "body": "Open the agent" }, "sound": "default" },
  "body": {
    "serverId": "host",
    "workspaceId": "workspace",
    "agentId": "agent",
    "reason": "finished"
  }
}
```

An Android FCM launch intent needs `google.message_id` and a JSON `body` extra.
An arbitrary Activity launch with data extras does not exercise Expo's FCM path.

Foreground pushes remain in Notification Center without a banner or sound.
This preserves notifications sent with stale presence information.

## Workspace names and icons

Resolve notification labels through the agent or terminal's workspace registry record and its project relation. Working directories do not establish project ownership. The daemon creates the same text for push and connected clients, so renamed labels do not depend on a client's directory cache being loaded.

Desktop and browser clients acquire icons through the existing project-icon cache. Rasterize images in a browser image element before passing PNG bytes to the OS adapter; this handles SVG without allowing repository markup to execute or load external resources. Client icon lookup has a 500 ms budget and cannot prevent alert delivery. Windows requires a local image file: retain small, content-addressed PNGs under desktop user data so Notification Center can still reference them after a restart. This cache has per-image limits; it does not have a total-size bound or expire files that notification history may still reference.

Native push keeps the Paseo icon and receives the same workspace text. Project images on mobile are deferred: Expo requires a retrievable image URL, and iOS additionally requires a notification service extension. Keep project image bytes out of the size-limited push payload.

## Cross-device clearing

Delivery acknowledgements belong to the existing authorized workspace, not a new device account. Persist their event sequence with the workspace, publish committed changes through its existing subscriptions, and reconcile from the next snapshot after reconnect. Agent attention remains the source of unread work; clearing a delivery must not resolve a pending permission or a newer attention event. Clients capture the delivery boundary and observed attention before queuing an offline acknowledgement.

Opening a foreground workspace and explicit OS dismissal synchronize existing deliveries. Opening settles the delivered alerts without marking the workspace's agents read, because unread status follows deliberate agent focus; Mark as read and an explicit OS dismissal still clear the attention they observed. Windows reports explicit dismissals while Paseo is running, including minimized; Android records its own notification delete callbacks durably and uploads them when the app resumes. Connected apps remove matching notifications immediately; offline or closed apps reconcile on resume. Android force-stop cannot guarantee immediate cleanup. iOS and browser APIs do not expose a reliable explicit swipe callback. Browser cleanup covers only the current session's notifications. Windows durable history requires the executable-owned fork identity; upstream and Debug histories remain separate.

Capture legacy own-notification identifiers at startup, then resolve missing workspace ownership through the same host's agent record. Unresolved ownership is retained for later lookup. Never infer a manual dismissal from a notification disappearing, and never clear a later unidentified notification as part of that startup backlog.

## Viewed chat

A notification for the chat you are looking at is skipped, and delivered ones for it are dismissed. A chat counts as viewed only when its pane is focused, ready and in the foreground; on compact layouts the agent pane must also be settled at rest (`mobile-panels/rest.ts`). `notifications/seen-agent.ts` owns the app side; `packages/desktop/src/features/viewed-agent-notifications/` owns Electron.

Both sides gate on visibility. The renderer knows which chat is painted; only the main process knows whether its window is visible and focused, and it receives notifications the renderer never created (Windows Notification Center history after a restart). The renderer reports its chat with a revision so a late report cannot replace a newer one.

A pending native show cannot be cancelled by closing the JS `Notification`. A dismissal requested before `show` waits for the show callback.

Windows exposes Notification Center history only through WinRT, which Electron does not wrap. `packages/desktop/src/features/windows-toast-history.ts` runs a PowerShell script that verifies the installer shortcut's app user model ID before reading or removing anything, and reads the current and the legacy (`electron.app.Paseo++`) namespaces. Only packaged Windows builds with an explicit app user model ID have history; other builds skip it.

## Startup and verification

Wait for the root navigator, host registry, remembered selection, and startup
redirects before handing off a tap. A compact agent route must demand the host's
directory itself; its sidebar can be closed for the entire cold launch.

Verify warm and cold taps, stale and missing workspace hints, two distinct taps,
and Android Back followed by launcher reopen or a different notification tap. Check the focused tab and every
workspace's saved layout, since a foreign pinned tab survives navigation.
Use the daemon's payload shape on both iOS and Android; a browser event alone
does not test native replay or acknowledgement.

Existing foreign pins belong to the reconciliation fix in
[#6900](https://github.com/getpaseo/paseo/issues/6900). Desktop main-process window
selection is tracked separately in
[#6875](https://github.com/getpaseo/paseo/issues/6875).
