# Notifications — How It Works (as-built)

This documents the **actual** notification system as implemented on Android and iOS. For the
original design intent, privacy invariants, and the cross-platform contract, see
[PUSH_NOTIFICATIONS.md](./PUSH_NOTIFICATIONS.md) — but where that doc's *flow* disagrees with
this one, **this doc is correct**.

> **History:** an earlier build had three competing owners of the kit client and two consumers
> racing for the single-consumer `incomingMessages` channel, so notifications had to be posted
> from the live receive loop and cold-start (killed-process) wakes did nothing. That race and
> the cold-start gap are **fixed** — see [Why this changed](#why-this-changed).

## TL;DR

- The server only ever sends a **silent, content-free push** (`{ "action": "check" }`).
- The device decides whether to show a notification, and the text is **always generic**
  ("New pix" / "New message") — never sender, content, or IDs.
- Each platform has **one** process-scoped owner of the kit client, and **one** consumer of
  `incomingMessages`. That single consumer posts the notification. There is no race.
- The owner is created at **process start**, before any RN bridge exists, so a silent push can
  restore the session and drain messages even on a cold start (app was killed).

## Components

### Android

| File | Role |
|------|------|
| `android/app/src/main/java/com/obscuraapp/ObscuraSession.kt` | **Process-scoped single source of truth.** Owns the kit client lifecycle (create/restore/destroy), session prefs, `ProcessLifecycleOwner` foreground tracking, and **THE single consumer** of `incomingMessages` — which fans out to the bound `EventSink` (the RN bridge, when alive) *and* posts background notifications. Initialized from `MainApplication.onCreate`. |
| `android/app/src/main/java/com/obscuraapp/MainApplication.kt` | Calls `ObscuraSession.init(this)` in `onCreate`, so the session restores and starts consuming **before** the RN bridge is built. |
| `android/app/src/main/java/com/obscuraapp/ObscuraMessagingService.kt` | `FirebaseMessagingService`. On a silent push, just calls `ObscuraSession.onPushWake()`. On token rotation, `ObscuraSession.deliverPushToken()`. Owns no state, posts no notifications. |
| `android/app/src/main/java/com/obscuraapp/ObscuraBridgeModule.kt` | RN native module. Owns **zero** state — implements `ObscuraSession.EventSink` and forwards RPCs to `ObscuraSession.client`. |
| `android/app/src/main/java/com/obscuraapp/NotificationHelper.kt` | The **one** place a notification is built/posted. Enforces the privacy invariant (generic text, fixed channel + `NOTIFICATION_ID = 1`). |

### iOS

| File | Role |
|------|------|
| `ios/ObscuraApp/ObscuraBridge.swift` | RN native module **and** owner of a **process-scoped** `static sharedClient`. `ensureClient()` get-or-restores that one client (concurrency-safe), shared by the live bridge and the static `handleSilentPush`. Restores from `UserDefaultsSessionStorage`. Posts the notification via the static `postGenericNotification`. |
| `ios/ObscuraApp/AppDelegate.swift` | Receives APNS/FCM tokens and silent pushes; forwards each silent push to `ObscuraBridge.handleSilentPush`. |

### Shared

| Component | Role |
|-----------|------|
| ObscuraKit | The data layer. Receives/decrypts envelopes, exposes them on `incomingMessages`, and provides `registerPushToken()` + `processPendingMessages()`. **Never** posts OS notifications. |

## Token registration

```
App foreground (after connect)
  → requestPushPermission()                      (POST_NOTIFICATIONS on Android 13+ / APNS on iOS)
  → Firebase hands back an FCM token              → "FCM token: …"
  → deliverPushToken(token)                       → emits pushTokenReceived event
  → JS: Obscura.registerPushToken(token)
  → bridge.registerPushToken                      → kit → PUT /v1/push-tokens (device-scoped JWT)
```

Token rotations arrive natively (`onNewToken` on Android, `MessagingDelegate` on iOS) and route
through the same `deliverPushToken` path. The server upserts by **deviceId**, so re-registering
is safe and idempotent.

## Receiving a message → notification

There is **one** consumer per platform, and it handles both the live (process alive) and the
woken (silent push) case identically — the silent push just guarantees the client is connected
so the same consumer gets a chance to drain.

### Android

```
friend sends pix
  → server fans out the encrypted envelope to your device's gateway queue
  → (silent push may arrive in parallel → ObscuraMessagingService.onPushWake()
       → ObscuraSession.tryRestore() (restores session if cold) → processPendingMessages(25s)
         which connects + drives the drain)
  → kit decrypts and emits on incomingMessages
  → ObscuraSession's single collector receives it          → "Incoming: MODEL_SYNC from=…"
       modelName = msg.raw?.modelSync?.model               // "pix" | "directMessage"
       → fans out to EventSink (RN bridge updates in-app UI, if alive)
       → if !appInForeground:
            NotificationHelper.postGeneric(ctx, classify(msg, modelName))
                                                            → "Posted notification: New pix"
```

`classifyForNotification` maps: `pix → "New pix"`, `directMessage → "New message"`,
`FRIEND_REQUEST → "New friend request"`, everything else → no notification.

### iOS

```
silent push arrives → AppDelegate.didReceiveRemoteNotification
  → ObscuraBridge.handleSilentPush(completion:)
       → ensureClient()              // returns the live client, or restores one from
                                     // UserDefaultsSessionStorage on a cold start
       → client.processPendingMessages(timeout: 25)   // connects + drains + classifies
       → postGenericNotification(counts)               // "New pix" / "New message"
       → completion(.newData / .noData)
```

iOS posts only `"New pix"` / `"New message"` (friend requests are surfaced in-app, not as a
push notification). Foreground presentation is gated by `UNUserNotificationCenter willPresent`.

## Why this changed

The previous build (Android) had `incomingMessages` read by **two** consumers — the bridge's
always-on loop and the FCM drain's `processPendingMessages` — racing for each single-delivery
envelope. The drain usually lost (`Drained: pix=0`) whenever the process was alive, so the
notification had to come from the live loop, and a **killed-process** wake had no loop and no
client at all → no notification.

The fix made ownership single and process-scoped:

- **Android** — `ObscuraSession` is the lone owner and the lone consumer, created in
  `MainApplication.onCreate`. `onPushWake` restores + connects and lets that one consumer drain.
- **iOS** — the kit client is a `static sharedClient` reached via a concurrency-safe
  `ensureClient()`; `handleSilentPush` no longer bails when the RN bridge is absent — it
  restores the session itself. The bridge's `init` and a cold-start push share one in-flight
  restore, so they never build two clients on the same per-user DB.

## Foreground vs background

`ObscuraSession` (Android) observes `ProcessLifecycleOwner` and keeps `appInForeground`, seeded
from the **current** lifecycle state at init (not waiting for the first observer callback). The
consumer only posts a notification when `appInForeground == false`; foreground messages update
the in-app UI silently. iOS relies on `UNUserNotificationCenter willPresent` for the same effect.

## What works / what doesn't

| Scenario | Result |
|----------|--------|
| App foreground | Message shown in-app, **no** notification (intended) |
| App backgrounded, process alive | ✅ Notification via the single consumer |
| App killed (cold start), then a silent push | ✅ Session restored at process start → drain → notify |
| App **force-stopped** by the user | ❌ OS constraint: Android won't deliver FCM to a `force-stop`ped app (`FLAG_STOPPED`) until it's manually reopened. Not fixable in app code. |

## Privacy invariant

Title is only ever `"New pix"` or `"New message"` (Android may also show `"New friend request"`);
the tap intent carries **no** conversation/sender/message IDs. Android uses a fixed
`NOTIFICATION_ID` so repeat posts replace rather than stack. See
[PUSH_NOTIFICATIONS.md](./PUSH_NOTIFICATIONS.md#privacy-model) for the threat model (forensic
extraction of the notification DB).

## Server contract (unchanged)

```
PUT /v1/push-tokens        body { "token": "<fcm-token>" }   (device-scoped JWT)
```
Push payload the server sends (silent, content-free):
```json
{ "data": { "action": "check" },
  "android": { "priority": "HIGH", "collapseKey": "obscura_check" },
  "apns":    { "apns-push-type": "background", "content-available": 1 } }
```
The app and server must share the **same Firebase project** (`obscura-af88b`, sender
`245820007515`). If the server's FCM credentials point at a different project, FCM returns 200
and silently delivers to nobody.

## Build note (Android)

The consumer reads `msg.raw.modelSync.model` (a protobuf type) to choose "New pix" vs "New
message". The kit keeps protobuf as an `implementation` dependency, so the app declares
`com.google.protobuf:protobuf-java:3.25.3` itself for compile visibility — already present
transitively at runtime, so no version conflict. See `android/app/build.gradle`.

## Testing

### Live path (no real push needed)

```bash
ADB=~/Library/Android/sdk/platform-tools/adb
$ADB -s <device> logcat -c
# on the device: open app, log in, press HOME (do NOT force-stop)
# from another device/account: send a pix
$ADB -s <device> logcat -s ObscuraSession:V ObscuraMessagingService:V
# expect: Incoming: MODEL_SYNC → Posted notification: New pix
```

### Cold-start path

Kill the app from the recents switcher (not force-stop), then send a pix from another account.
`tools/push-sender/` is a standalone Kotlin CLI for driving real `MODEL_SYNC` pushes end-to-end;
see its README. The silent push should restore the session at process start and post the
notification without the app being opened.
