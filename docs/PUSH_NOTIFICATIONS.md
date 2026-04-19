# Push Notifications Plan

Shared contract between iOS and Android implementations. Both devs work from this document. Update when a decision changes.

## Privacy Model

**Threat avoided:** iOS caches notification content to a SQLite database that forensic tools can extract ([404 Media article](https://www.404media.co/fbi-extracts-suspects-deleted-signal-messages-saved-in-iphone-notification-database-2/)).

**Our approach:** Approach B — silent data-only pushes from server, generic local notifications on device.

### Invariants (do NOT violate)

1. **Server sends data-only pushes only.** Payload is `{ "action": "check" }`. No `alert`, no `title`, no `body`, no sender, no preview. The server already does this — we must never add content.
2. **Local notifications contain NO message data.** Only generic text:
   - New pix from friend → "New pix"
   - New chat message → "New message"
   - New story → "New story from friends"
   - Friend request → "New friend request"
3. **NO sender usernames in notification text.** Leaks social graph to forensic extract.
4. **NO captions, content, or previews in notification text.** Ever.
5. **NO attachment thumbnails in notifications.**

### Why stricter than Signal

Signal shows sender usernames in notifications, which is what got extracted in the 404 Media case. Obscura Pix is ephemeral-by-design — the whole value prop is that nothing sticks. Leaking sender metadata via notification DB contradicts the product.

## Server API (already deployed)

```
PUT /v1/push-tokens
Authorization: Bearer <device-scoped JWT>
Body: { "token": "<fcm-or-apns-token>" }
Response: 200 OK
```

- **Unified endpoint** for both FCM (Android) and APNS (iOS)
- **Per-device** — token tied to deviceId, not userId
- **Upsert semantics** — safe to call multiple times
- **No explicit unregister** — server auto-cleans invalid tokens on 404/403 from FCM/APNS, and cascades delete when the device is deleted via `DELETE /v1/devices/{deviceId}`

Server push payload (what client receives):
```json
{
  "data": { "action": "check" },
  "android": { "priority": "HIGH", "collapseKey": "obscura_check" },
  "apns": { "apns-push-type": "background", "content-available": 1 }
}
```

This is a **silent push** — iOS does not display anything, Android does not show a notification. The app wakes up briefly, connects to the gateway, processes queued messages.

## Client Architecture

```
App launch / after connect succeeds
  → request notification permission (FCM/APNS)
  → get push token
  → Obscura.registerPushToken(token)
  → kit's APIClient → PUT /v1/push-tokens

Push arrives (app backgrounded or killed)
  → OS wakes app (silent push)
  → native handler triggers kit.connect() if not connected
  → kit processes queued messages (encrypted envelopes)
  → kit emits MessageReceived events
  → native handler creates a LOCAL notification with generic text only
```

## Contract: what each layer does

### Kit (both platforms, independent)

Exactly two new methods. Signatures match across platforms:

```kotlin
// Kotlin (ObscuraKit-Kotlin)
suspend fun registerPushToken(token: String)
suspend fun processPendingMessages(timeout: Duration): ProcessedCounts

data class ProcessedCounts(
    val pixCount: Int,
    val messageCount: Int,
    val otherCount: Int  // debug only; bridge ignores
)
```

```swift
// Swift (ObscuraKit-Swift)
func registerPushToken(_ token: String) async throws
func processPendingMessages(timeout: Duration) async -> ProcessedCounts

struct ProcessedCounts {
    let pixCount: Int
    let messageCount: Int
    let otherCount: Int  // debug only; bridge ignores
}
```

**Semantics of `processPendingMessages(timeout)`:**
- Connect if not connected (call `ensureFreshToken()` + `gateway.connect()`)
- Wait up to `timeout` for the envelope queue to drain
- Return when either (a) queue is empty and stays empty for ~500ms, or (b) timeout hits
- Does NOT disconnect afterwards — OS will freeze the app when it wants
- Counts categorization (applied to each processed envelope):
  - `MODEL_SYNC` with `sync.model == "pix"` → `pixCount`
  - `MODEL_SYNC` with `sync.model == "directMessage"` → `messageCount`
  - Legacy `TEXT` or `IMAGE` ClientMessage (routed through `messages.add()`) → `messageCount`
  - Everything else (FRIEND_REQUEST, DEVICE_ANNOUNCE, SYNC_BLOB, MODEL_SIGNAL, SESSION_RESET, etc.) → `otherCount`
  - Rationale: bridge picks notification text from pix vs message counts; `otherCount` is debug-only

**Invariant:** Kit must NEVER call OS notification APIs (`UNUserNotificationCenter` on iOS, `NotificationManagerCompat` on Android). Notification posting is strictly the bridge layer's responsibility. Kit only returns counts.

That's it. Kit does not:
- Handle push reception (that's native/bridge)
- Display notifications (that's native/bridge)
- Manage token lifecycle (that's bridge)

### Bridge (thin pass-through + native push handling)

**JS-facing method (both platforms):**
- `registerPushToken(token, promise)` — calls `client.registerPushToken(token)`

**Platform-specific push reception:**
- **Android:** `FirebaseMessagingService.onMessageReceived()` in `android/app/src/main/java/...`
  - When silent push arrives with `action=check`:
    - Ensure client is connected (call `client.connect()` if needed)
    - Kit processes queued messages via existing envelope loop
    - After processing, check if any new entries arrived
    - If yes: create local notification via `NotificationCompat.Builder` with generic text ("New pix" / "New message")
- **iOS:** `AppDelegate.application(_:didReceiveRemoteNotification:fetchCompletionHandler:)`
  - Same flow: connect if needed, let kit process, post generic `UNMutableNotificationContent`

**Platform-specific token management:**
- **Android:** Register FCM token refresh callback via `FirebaseMessaging.getInstance().token` listener. On refresh, emit event to JS → JS re-registers.
- **iOS:** `UIApplication.shared.registerForRemoteNotifications()` + `didRegisterForRemoteNotificationsWithDeviceToken` → emit event → JS registers.

### JS (shared)

- On app launch after `connect()` succeeds:
  ```typescript
  const token = await requestPushPermissionAndGetToken(); // RN lib call
  if (token) await Obscura.registerPushToken(token);
  ```
- Listen for token refresh events and re-register
- No notification handling — all in native

### Shared RN packages to install

- `@react-native-firebase/app`
- `@react-native-firebase/messaging`

iOS additionally requires APNS entitlements in Xcode (Push Notifications capability + Background Modes → Remote notifications).

## Decisions (agreed)

| Question | Decision |
|----------|----------|
| Notification content | Approach B — generic text only, no sender/content/preview |
| Token registration timing | After first successful `connect()` per app launch |
| Token refresh | Native listens for refresh → emits event → JS re-registers |
| Background wake | Native handles (iOS AppDelegate / Android FirebaseMessagingService) |
| Local notification generation | Native (so it works when app is killed) |
| Logout behavior | No explicit unregister. `fullLogout()` deletes the device → server cascades token delete. |
| Notification Service Extension (iOS) | NOT needed. We don't decrypt in push handler. |

## Decisions (open)

1. **Firebase project setup** — Ryan owns. One-time: create the Obscura Firebase project, drop `GoogleService-Info.plist` in `ios/` and `google-services.json` in `android/app/`.

## Deep linking on tap

Notification `userInfo` (iOS) / `data` (Android) may contain a screen name only — e.g. `{ "screen": "chat" }`. Never include conversation IDs, sender IDs, message IDs, or any other identifiers. On tap, navigate to the chat list (friends + pix). User picks the unread item themselves.

This matches the privacy model: the notification DB extract reveals "something happened, user checked chat tab" — nothing more.

## UX intent (each platform implements natively)

Grouping, sound, and badge behavior are native bridge concerns — each platform picks the idiomatic implementation. Intent:

- **Grouping:** one notification per push wake, regardless of sender count. Minimize notification DB entries.
  - Pix-wins-tie: if both pix and messages arrive in one wake, post a single "New pix" notification.
  - Only pix: "New pix".
  - Only messages: "New message".
  - Neither: no notification (silent push just syncs state).
  - No per-sender fanout. No per-conversation grouping. One notification, fixed text.
- **Sound/vibration:** default system sound, respects user's system settings (do-not-disturb, silent mode, etc.).
- **Badge count:** deferred to v2. "Unread" semantics unclear (when does it decrement — on view, on open, on expiry?). For v1, skip badge updates. When we add it, kit will expose an observable unread count — `receivedPixCount where !viewedAt` + `unreadMessageCount`.

## Implementation order

1. **Kit method** — both devs add `registerPushToken()` to their kit. Non-breaking, can ship without client integration. (1 hour each)
2. **Bridge method** — both devs add the `@ReactMethod` / `@objc` pass-through. (30 min each)
3. **JS integration** — shared code, one dev writes, both pull. Requests permission, gets token, calls bridge. (1 hour)
4. **Native push receivers** — platform-specific. Android's FirebaseMessagingService + iOS AppDelegate handler. Local notification generation. (2-3 hours each, done independently)
5. **End-to-end test** — send pix from iOS to Android with Android app killed. Notification should arrive with generic text only. Repeat in reverse direction.

## Acceptance criteria

- [ ] App requests notification permission successfully on both platforms
- [ ] Silent push still wakes the app when killed (backgrounded + fully terminated)
- [ ] Token registration succeeds and returns 200
- [ ] Silent push arrives → app wakes → messages process → local notification shows
- [ ] Local notification text is generic only (no sender, no content)
- [ ] Tapping notification opens app to the chat list tab (option c: screen name only, no IDs in `userInfo`/`data`)
- [ ] iOS notification DB extract (via `sqlite3` on unpacked backup) shows only generic text
- [ ] Logout via `fullLogout()` causes subsequent pushes to fail at server (token was cascade-deleted)
- [ ] Token refresh triggers re-registration automatically
