# Notifications — How It Works (as-built)

This documents the **actual** notification system as implemented and verified on Android
(2026-06-22). For the original design intent, privacy invariants, and the cross-platform
contract, see [PUSH_NOTIFICATIONS.md](./PUSH_NOTIFICATIONS.md) — but where that doc's
*flow* disagrees with this one, **this doc is correct**.

## TL;DR

- The server only ever sends a **silent, content-free push** (`{ "action": "check" }`).
- The device decides whether to show a notification, and the text is **always generic**
  ("New pix" / "New message") — never sender, content, or IDs.
- A message can reach the device two ways: the **live gateway loop** (process alive) or the
  **FCM drain** (process was asleep). Whichever receives it posts the notification, through one
  shared helper. In practice, while the app process is alive the **live loop wins** — see
  [The Channel race](#the-channel-race) for why that matters.

## Components

| File | Role |
|------|------|
| `android/app/src/main/java/com/obscuraapp/ObscuraMessagingService.kt` | `FirebaseMessagingService`. Receives FCM token rotations + silent pushes. On a push, runs the kit's FCM **drain** and posts via `NotificationHelper`. |
| `android/app/src/main/java/com/obscuraapp/ObscuraBridgeModule.kt` | RN native module. Owns the kit client, the **live envelope loop**, foreground/background tracking, and token registration. Posts the notification from the receive loop when backgrounded. |
| `android/app/src/main/java/com/obscuraapp/NotificationHelper.kt` | The **one** place a notification is built/posted. Enforces the privacy invariant (generic text, fixed channel + notification id). Called by both delivery paths. |
| ObscuraKit (`com.obscura:obscura-kit`) | The data layer. Receives/decrypts envelopes, exposes them on `incomingMessages`, and provides `registerPushToken()` + `processPendingMessages()`. **Never** posts OS notifications. |

## Token registration

```
App foreground (after connect)
  → ObscuraBridge.requestPushPermission()      (POST_NOTIFICATIONS on Android 13+)
  → FirebaseMessaging.getInstance().token       → "FCM token: …"
  → deliverPushToken(token)                      → emits ObscuraEvent { pushTokenReceived }
  → JS: Obscura.registerPushToken(token)
  → ObscuraBridge.registerPushToken             → kit → PUT /v1/push-tokens (device-scoped JWT)
  → "registerPushToken OK"
```

Token rotations arrive via `ObscuraMessagingService.onNewToken` → same `deliverPushToken` path.
The server upserts by **deviceId**, so re-registering is safe and idempotent.

## Receiving a message → notification

There are two delivery paths. Both end at `NotificationHelper.postGeneric(...)`.

### Path 1 — live gateway loop (process alive, app backgrounded)

```
friend sends pix
  → server fans out encrypted envelope to your device's gateway queue
  → kit's gateway loop receives + decrypts it
  → kit emits it on the `incomingMessages` channel
  → ObscuraBridgeModule's consumer loop picks it up   → "Incoming: MODEL_SYNC from=…"
  → emits messageReceived to JS (updates in-app UI)
  → if app is BACKGROUNDED:
       model = msg.raw.modelSync.model              // "pix" | "directMessage"
       NotificationHelper.postGeneric(ctx, "New pix" | "New message")
                                                     → "Posted notification: New pix"
```

The silent FCM push still arrives in parallel and wakes `ObscuraMessagingService`, but its
drain comes back empty (`Drained: pix=0`) — see below. That's expected and harmless; the live
loop already posted the notification.

### Path 2 — FCM drain (process was asleep)

```
silent push arrives → ObscuraMessagingService.onMessageReceived  "Silent push received"
  → client.processPendingMessages(25s)
       connects if needed, drains queued envelopes, classifies into ProcessedCounts
  → "Drained: pix=N msg=M other=O"
  → NotificationHelper.postGeneric(ctx, "New pix" | "New message")
```

This is the path the original design assumed would always run. It only actually delivers when
the live loop is **not** consuming (i.e. the process had no active client), because of:

## The Channel race

`incomingMessages` is a **single-consumer Kotlin `Channel`** — each envelope is handed to
exactly one receiver. Two things read from it:

- `ObscuraBridgeModule`'s always-on consumer loop (`for (msg in c.incomingMessages)`)
- `processPendingMessages` (`incomingMessages.tryReceive()`), invoked by the FCM drain

**Whenever the app process is alive, the always-on loop wins the race.** So the FCM drain sees
an empty queue and returns `pix=0`. This is why notifications must be (and now are) posted from
the **receive loop**, not solely from the drain. The drain remains as the fallback for the case
where it is the only consumer.

Verified log (phone, backgrounded, two pix sent):

```
Silent push received, data={action=check}     ← FCM wakes the messaging service
Drained: pix=0 msg=0 other=0                   ← drain loses the race, as expected
Incoming: MODEL_SYNC from=019ef293             ← live loop receives the pix
Posted notification: New pix                   ← notification posted from the loop ✅
Incoming: MODEL_SYNC from=019ef293
Posted notification: New pix                   ← second pix ✅
```

## Foreground vs background

`ObscuraBridgeModule` observes `ProcessLifecycleOwner` and keeps an `appInForeground` flag
(`onStart` → true, `onStop` → false). The receive loop only posts a notification when
`appInForeground == false`. Foreground messages update the in-app UI silently — no banner,
because the user is already looking at the app.

## What works / what doesn't

| Scenario | Result |
|----------|--------|
| App foreground | Message shown in-app, **no** notification (intended) |
| App backgrounded, process alive | ✅ Notification via the live loop |
| App killed / force-stopped | ❌ **Not yet.** No live loop, and a headless FCM wake doesn't initialize the RN bridge/client. Also Android won't deliver FCM to a `force-stop`ped app at all (FLAG_STOPPED) until it's manually reopened. |

The killed/cold-start case needs headless React Native initialization (or a native-only drain
path that can run without the JS bridge). Tracked as future work.

## Privacy invariant

Enforced in `NotificationHelper`: title is only ever `"New pix"` or `"New message"`; the tap
intent carries `screen=chat` and **no** conversation/sender/message IDs. Fixed `NOTIFICATION_ID`
means repeat posts replace rather than stack. See [PUSH_NOTIFICATIONS.md](./PUSH_NOTIFICATIONS.md#privacy-model)
for the threat model (forensic extraction of the notification DB).

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

## Build note

The bridge reads `msg.raw.modelSync.model` (a protobuf type) to choose "New pix" vs "New
message". The kit keeps protobuf as an `implementation` dependency, so the app must declare
`com.google.protobuf:protobuf-java:3.25.3` itself for compile visibility — already present
transitively at runtime, so no version conflict. See `android/app/build.gradle`.

## Testing

No Firebase or real push needed to exercise the live-loop path — just background the app and
send a real message from another device:

```bash
ADB=~/Library/Android/sdk/platform-tools/adb
$ADB -s <device> logcat -c
# on the device: open app, log in, press HOME (do NOT force-stop)
# from another device/account: send a pix
$ADB -s <device> logcat -s ObscuraBridge:V ObscuraMessagingService:V
# expect: Incoming: MODEL_SYNC → Posted notification: New pix
```

To exercise the real FCM path you need a Google Play device/emulator + the server actually
sending (the silent push only adds value for the killed-process case, which is still open).
```
