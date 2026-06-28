# Pix bridge contract

This is the contract between the JS UI layer and the per-platform native
bridges (Kotlin on Android, Swift on iOS). It is the **single source of
truth**: every method here MUST be implemented by both platforms, and every
event here MUST be emitted with the exact payload shape shown.

The TS facade lives in [`src/native/ObscuraModule.ts`](../src/native/ObscuraModule.ts);
keep this document in sync with that file.

## Design principles

- **Bytes don't cross the bridge.** Files are referenced by absolute path.
  Anything that wants to share bytes between JS and native goes through the
  filesystem — JS receives a path, hands a path back to native for upload.
  No base64 round-trips, no megabyte-sized strings flying across the bridge.
- **Schema is the only thing duplicated.** [`src/models/schema.ts`](../src/models/schema.ts)
  is read by both bridges via `defineModels(schema)`; neither side hardcodes
  model definitions.
- **One event stream, discriminated by `type`.** All native → JS events flow
  through `ObscuraEvent` with `{ type, …fields }`. Adding an event type means
  updating both the TS union and both native implementations.
- **Promises for RPC, events for everything reactive.** Methods return
  `Promise<T>`; state changes / messages / typing arrive via events.

## Methods

All methods return a `Promise`. The "both" column means both Android and iOS
must implement; "android only" means iOS may either no-op or throw.

### Auth

| Method | Args | Returns | Platforms |
|---|---|---|---|
| `register(username, password)` | strings | `void` | both |
| `loginSmart(username, password)` | strings | `LoginScenario` | both |
| `loginAndProvision(username, password)` | strings | `void` | both |
| `connect()` | — | `void` | both |
| `disconnect()` | — | `void` | both |
| `logout()` | — | `void` | both |

`LoginScenario` is one of: `existingDevice` `newDevice`
`deviceMismatch` `invalidCredentials` `userNotFound`.

### Current state (synchronous reads of kit state)

| Method | Returns | Platforms |
|---|---|---|
| `getConnectionState()` | `ConnectionState` | both |
| `getAuthState()` | `AuthState` | both |
| `getUserId()` | `string \| null` | both |
| `getUsername()` | `string \| null` | both |
| `getDeviceId()` | `string \| null` | both |

`ConnectionState`: `disconnected` `connecting` `connected`.
`AuthState`: `loggedOut` `authenticated` `pendingApproval`.

### Friends

| Method | Args | Returns | Platforms |
|---|---|---|---|
| `befriend(userId, username)` | strings | `void` | both |
| `acceptFriend(userId, username)` | strings | `void` | both |
| `getFriendCode()` | — | `string` (base64-wrapped JSON `{n,u}`) | both |
| `addFriendByCode(code)` | string | `void` | both |
| `getFriends()` | — | `Friend[]` | both |
| `getPendingRequests()` | — | `Friend[]` | both |

`Friend = { userId, username, status: 'pending_sent' \| 'pending_received' \| 'accepted' }`.

### Device linking

| Method | Args | Returns | Platforms |
|---|---|---|---|
| `generateLinkCode()` | — | `string` | both |
| `validateAndApproveLink(code)` | string | `void` | both |

### ORM

| Method | Args | Returns | Platforms |
|---|---|---|---|
| `defineModels(schemaJson)` | JSON string | `void` | both |
| `createEntry(model, dataJson)` | strings | `ModelEntry` | both |
| `upsertEntry(model, id, dataJson)` | strings | `ModelEntry` | both |
| `queryEntries(model, conditionsJson)` | strings | `ModelEntry[]` | both |
| `allEntries(model)` | string | `ModelEntry[]` | both |
| `deleteEntry(model, id)` | strings | `void` | both |

`ModelEntry = { id, data: Record<string, any>, timestamp, authorDeviceId }`.

**Side effect:** `createEntry`, `upsertEntry`, `deleteEntry` MUST emit an
[`entriesChanged`](#entrieschanged) event for the affected model after the
operation succeeds. Other screens rely on this to re-query reactively.

### Typing signals

| Method | Args | Returns | Platforms |
|---|---|---|---|
| `sendTyping(conversationId)` | string | `void` | both |
| `stopTyping(conversationId)` | string | `void` | both |
| `observeTyping(conversationId)` | string | `void` | both |
| `stopObservingTyping(conversationId)` | string | `void` | both |

While an observation is active, the bridge emits
[`typingChanged`](#typingchanged) whenever the typer set for that
conversation changes.

### Attachments (path-based)

Bytes never cross the bridge. `uploadAttachment` reads from a local file path;
`downloadAttachment` decrypts to a cache file and returns its absolute path.

| Method | Args | Returns | Platforms |
|---|---|---|---|
| `uploadAttachment(filePath)` | string | `{ id, contentKey, nonce }` | both |
| `downloadAttachment(id, contentKey, nonce)` | strings | absolute file path | both |

Downloads are cached at `<cacheDir>/attachments/<safeId>.jpg`; repeat calls
short-circuit on cache hit. Implementations MUST:
- Sanitize the id to a safe filename before writing (no path traversal).
- **Publish atomically.** Write to a sibling temp file first, then rename into
  place. The "cache hit" branch must never observe a partially-written file
  while a concurrent call is mid-write.

### Image processing (path-in, path-out)

| Method | Args | Returns | Platforms |
|---|---|---|---|
| `resizeImage(srcPath, maxDim, quality)` | string, int, int | `{ path, width, height }` | both |
| `writeTestImage(width, height)` | ints | `{ path, width, height }` | both |

`resizeImage` re-encodes as JPEG at `quality` (1-100) so the largest side is at
most `maxDim` px. Implementations MUST:
- Honor EXIF `Orientation` — the output pixels are in display orientation
  (front-camera selfies must not render rotated). On Android this means
  reading `ExifInterface.TAG_ORIENTATION` and baking the rotation/flip into
  the bitmap matrix; on iOS, normalize via `UIImage.imageOrientation` before
  re-encoding.
- Keep peak memory bounded for multi-megapixel sources (Android: `inSampleSize`
  two-pass decode; iOS: `ImageIO` with `kCGImageSourceThumbnailMaxPixelSize`).
- Reject `maxDim <= 0`. Clamp `quality` to `1..100`.
- Surface OOM as a promise rejection, not a hang.

`writeTestImage` is used by the emulator/no-camera fallback in `CameraScreen`.
Reject zero or pathologically-large dimensions.

The source file is untouched in both cases.

### Push notifications

| Method | Args | Returns | Platforms |
|---|---|---|---|
| `requestPushPermission()` | — | `boolean` (granted) | both |
| `registerPushToken(token)` | string | `void` | both |

`requestPushPermission` MUST:
1. Trigger the platform-native permission UI if not already decided.
2. Fetch the platform push token (FCM on Android, APNs/FCM-via-APNs on iOS).
3. Deliver the token via a [`pushTokenReceived`](#pushtokenreceived) event.

The JS layer listens for `pushTokenReceived` and calls `registerPushToken`
to upsert it on the server.

### Deep linking

| Method | Args | Returns | Platforms |
|---|---|---|---|
| `getLaunchIntent()` | — | `{ screen: string } \| null` | both |

`getLaunchIntent` returns the cold-start deep-link target and consumes it
(repeat calls return null). Called once by JS on app mount. Warm-start
deep-links (app already running, notification tapped) arrive via the
[`launchedFrom`](#launchedfrom) event instead — the bridge isn't built yet
at cold start so the pull API is the only way to learn about that case.

The current schema is a single `screen` string. Implementations:
- Android: read intent extras (`intent.getStringExtra("screen")`) in
  the host activity, hook `onNewIntent` for warm starts.
- iOS: read launch options / `UNNotificationResponse.userInfo` in
  `application(_:didFinishLaunchingWithOptions:)` and the notification
  delegate's `didReceive` callback.

### Misc

| Method | Args | Returns | Platforms |
|---|---|---|---|
| `getDebugLog()` | — | `string[]` | both |
| `setSecureScreen(enabled)` | bool | `void` | android (no-op acceptable on iOS) |
| `deleteFile(path)` | string | `void` | both |
| `setClipboard(text)` | string | `void` | both |

`setSecureScreen` should set `FLAG_SECURE` on Android (prevents app preview
from appearing in recents / screenshots). A future iOS implementation
could blur the app when backgrounded.

`deleteFile` is best-effort; missing-file failures should resolve, not reject.

### RN plumbing

| Method | Notes |
|---|---|
| `addListener(eventName)` | Required by `NativeEventEmitter`. No-op stub. |
| `removeListeners(count)` | Required by `NativeEventEmitter`. No-op stub. |

## Events

The bridge emits a single named stream — `ObscuraEvent` — whose payloads are
discriminated by `type`. The TS union in
[`src/native/ObscuraModule.ts`](../src/native/ObscuraModule.ts) is the
authoritative shape; any new event type added there MUST be emitted from both
native implementations, or it will silently never fire.

### `connectionChanged`
`{ type: 'connectionChanged', state: ConnectionState }` — emitted whenever
the underlying WebSocket connection state transitions.

### `authStateChanged`
`{ type: 'authStateChanged', state: AuthState }` — emitted on login,
logout, and pending-approval transitions. JS treats `'loggedOut'` as
"session is gone, route to AuthScreen."

### `authFailed`
`{ type: 'authFailed', reason: string }` — emitted when the kit's token
refresh has exhausted its retry budget. JS treats this as "session is gone,
route to AuthScreen."

### `appStateChanged`
`{ type: 'appStateChanged', state: 'active' | 'background' }` — emitted on
process-wide foreground/background transitions. JS uses this to refresh
data on resume or pause expensive listeners on background. Replayed once
to a freshly-bound bridge so JS sees the current state without waiting for
the next transition.

### `launchedFrom`
`{ type: 'launchedFrom', screen: string }` — emitted when a warm-start
deep-link arrives (app already running, notification tapped). For cold
starts use [`getLaunchIntent`](#deep-linking) instead.

### `friendsUpdated`
`{ type: 'friendsUpdated', friends: Friend[] }` — emitted whenever the
friend list (accepted + pending) changes. Payload is the full list — JS
splits it by status.

### `messageReceived`
`{ type: 'messageReceived', model: string }` — emitted when a remote
`MODEL_SYNC` envelope arrives. Payload is intentionally minimal; consumers
re-query the affected model. **Do not** synthesize a fake entry id here.

### `entriesChanged`
`{ type: 'entriesChanged', model: string }` — emitted after a successful
local CRUD (`createEntry`, `upsertEntry`, `deleteEntry`). Lets screens
re-query without resorting to manual refresh triggers.

### `typingChanged`
`{ type: 'typingChanged', conversationId: string, typers: string[] }` —
emitted while an `observeTyping(conversationId)` is active. `typers` is the
current set of remote device ids that are typing.

### `pushTokenReceived`
`{ type: 'pushTokenReceived', token: string }` — emitted when a fresh push
token is available (after `requestPushPermission`, on cold start with a
cached token, or on rotation). JS calls `registerPushToken` in response.

### `debugLog`
`{ type: 'debugLog', message: string }` — kit-level diagnostic line. Surfaced
in the in-app Settings debug log.

## Naming / shape rules

- `type` is the discriminator, always a kebab-free camelCase string.
- Event fields are flat scalars or simple arrays. No nested objects unless
  truly necessary (`friendsUpdated.friends` is the only nested array today).
- Method args are scalars (`string`/`number`/`boolean`) or JSON strings for
  free-form objects (`createEntry(model, dataJson)`). This keeps the marshalling
  story identical on both platforms.

## Adding to the contract

1. Update [`ObscuraModule.ts`](../src/native/ObscuraModule.ts) — add the
   method/event with full types.
2. Implement in `ObscuraBridgeModule.kt` (Android).
3. Implement in `ObscuraBridge.swift` (iOS).
4. Add a row here.
5. If it's a new event, verify both natives use the single `emit(type, build)`
   helper (Android) / equivalent (iOS) so payload shape doesn't drift.
