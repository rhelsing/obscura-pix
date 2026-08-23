# Pix bridge contract

This is the contract between the JS UI layer and the per-platform native
bridges (Kotlin on Android, Swift on iOS). It is the **single source of
truth** for method and event shapes. Unless a platform exception is stated,
every method MUST be implemented by both platforms and every event MUST use the
exact payload shape shown. [`IOS_PARITY.md`](IOS_PARITY.md) records the current
iOS implementation gaps.

The TS facade lives in [`src/native/ObscuraModule.ts`](../src/native/ObscuraModule.ts);
keep this document in sync with that file.

## Design principles

- **Bytes don't cross the bridge.** Files are referenced by absolute path.
  Anything that wants to share bytes between JS and native goes through the
  filesystem — JS receives a path, hands a path back to native for upload.
  No base64 round-trips, no megabyte-sized strings flying across the bridge.
- **Nothing parses a payload, on either side.** `data` / `payload` cross as
  opaque JSON **strings**. The kit stores bytes it cannot read
  ([`NATIVE_CONTRACT.md` §0.4](https://github.com/barrelmaker97/obscura-native/blob/240f526/docs/NATIVE_CONTRACT.md)); the app parses them once, on
  the way in (`store.ts`'s `loadEntries`). There is no schema on this bridge —
  `src/models/schema.ts` is read by the app alone and never crosses.
- **The caller names the recipients.** `sendEntry` takes a userId list and the
  kit fans out to exactly those (plus the author's own *other* devices). It
  resolves no audience of its own. Audience resolution is
  `src/domain/audience.ts`.
- **Identity comes from the envelope.** `inboxPeek` returns `senderUserId` /
  `senderDeviceId`, stamped by the server and unforgeable by the sender
  (`NATIVE_CONTRACT.md` §0.10). A bridge MUST NOT synthesize either from payload content.
- **One event stream, discriminated by `type`.** All native → JS events flow
  through `ObscuraEvent` with `{ type, …fields }`. Adding an event type means
  updating both the TS union and both native implementations.
- **Promises for RPC, events for everything reactive.** Methods return
  `Promise<T>`; state changes / messages / typing arrive via events.

## Rejections

A rejection carries a `code`. Kit-level failures use one of `NOT_AUTHENTICATED`
`NOT_PROVISIONED` `NOT_FRIENDS` `NO_DEVICES` `NO_MESSENGER` `TIMEOUT`
`DEVICE_LINK_FAILED` `SEND_FAILED`; anything else falls back to a per-method
code (`INBOX_PEEK_ERROR`, `ENTRY_PUT_ERROR`, …).

`DIRECT_ROUTING_UNRESOLVED` is **not** a bridge code. No kit throws it any more
— audience resolution is the app's (`DOMAIN_CONTRACT.md`) — and it is raised by
`src/domain/audience.ts` without crossing this boundary.

## Methods

All methods return a `Promise`. The "both" column means both Android and iOS
must implement; "android only" means iOS may either no-op or throw.

### Auth

| Method | Args | Returns | Platforms |
|---|---|---|---|
| `registerUser(username, password)` | strings | `void` | both |
| `loginSmart(username, password)` | strings | `LoginScenario` | both |
| `loginAndProvision(username, password)` | strings | `void` | both |
| `connect()` | — | `void` | both |
| `disconnect()` | — | `void` | both |
| `logout()` | — | `void` | both |

`LoginScenario` is one of: `existingDevice` `newDevice`
`deviceMismatch` `invalidCredentials` `userNotFound`.

### Current state (reads of kit state)

| Method | Returns | Platforms |
|---|---|---|
| `getConnectionState()` | `ConnectionState` | both |
| `getAuthState()` | `AuthState` | both |
| `getUserId()` | `string \| null` | both |
| `getUsername()` | `string \| null` | both |
| `getDeviceId()` | `string \| null` | both |

`ConnectionState`: `disconnected` `connecting` `reconnecting` `connected`.
`AuthState`: `loggedOut` `authenticated` `pendingApproval`.

`getUserId` is load-bearing beyond display: the inbox drain refuses to store
anything without it, because it cannot authorize a write without knowing who
this device is.

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

The friend graph is the app's **only** source of display names (`NATIVE_CONTRACT.md` §0.5). A
name that did not come from here came from a peer.

### Device linking

| Method | Args | Returns | Platforms |
|---|---|---|---|
| `generateLinkCode()` | — | `string` | both |
| `validateAndApproveLink(code)` | string | `void` | both |

### The inbox ([`KIT_API.md` §3](https://github.com/barrelmaker97/obscura-native/blob/240f526/docs/KIT_API.md))

How messages arrive. The kit persists a row, ACKs, and then notifies — and
**an ACK is a DELETE**, so once a row exists the server's copy is gone and the
row is the only copy of that message anywhere.

| Method | Args | Returns | Platforms |
|---|---|---|---|
| `inboxPeek(limit)` | int | `InboxRow[]` | both |
| `inboxConsume(ids)` | number[] | `void` | both |
| `inboxDiscard(ids, reason)` | number[], string | `void` | both |
| `inboxDepth()` | — | number | both |

```ts
InboxRow = {
  id: number             // monotonic per install; drain order. NOT a message id.
  envelopeId: string     // server-assigned. The kit's dedupe key: UNIQUE + INSERT OR IGNORE.
  kind: string           // the client.proto payload arm, e.g. "MODEL_SYNC"
  receivedAt: number
  senderUserId: string           // server-stamped (NATIVE_CONTRACT §0.10)
  senderDeviceId: string|null    // the decrypting session's address — the merge tie-break
  senderDisplayName: string|null // from the kit's friend graph; null if not a friend
  modelKey: string|null  // ModelSync-derived, so null for every other kind
  entryId: string|null
  sentAt: number|null    // peer-supplied; clamped per NATIVE_CONTRACT §2.4 before storage
  payload: string        // opaque JSON string
}
```

Implementations MUST:

- **`inboxPeek` is side-effect free.** Peeking twice without consuming returns
  the same rows, in `id` order. That is the crash-safety property the drain
  depends on, not a bug (§3.3 rule 3).
- **Delete a row only on `inboxConsume` or `inboxDiscard`.** Not on reconnect,
  not on logout, not on a size cap, not on a TTL (§3.3 rule 2). A device wipe
  or remote revocation is the one carve-out, and it destroys the store rather
  than selecting rows.
- **`inboxConsume` is idempotent and accepts a subset.** Partial progress is
  normal.
- **`inboxDiscard` requires a non-empty `reason`** and MUST log it as a
  security-relevant event (§3.3 rule 5). It is data loss chosen deliberately.
  The app logs it too — a discard must never be the quiet path.
- **Dedupe on `envelopeId`** (`UNIQUE` + `INSERT OR IGNORE`, §3.3 rule 8).
  Persist-then-ack *guarantees* redelivery: the ack is best-effort and its
  failure is swallowed, so the same envelope arriving twice is routine.
- **`senderDeviceId` comes from the address of the session that decrypted the
  message**, never from a wire field (`NATIVE_CONTRACT.md` §0.10 rule 4).

There is deliberately **no insert**: the inbox is kit-write, app-read-and-delete
(§3.3 rule 9). The sending device gets no inbox row for its own send and writes
its own entry directly.

### The entry store ([`KIT_API.md` §8.1](https://github.com/barrelmaker97/obscura-native/blob/240f526/docs/KIT_API.md))

Where the app keeps what it made of the inbox. The kit owns the table; it has no
opinion about the contents.

| Method | Args | Returns | Platforms |
|---|---|---|---|
| `entryPut(model, id, dataJson, sentAt, authorDeviceId)` | string, string, string, number, string | `void` | both |
| `entryAll(model)` | string | `StoredEntry[]` | both |

`StoredEntry = { id, data: string, sentAt, authorDeviceId }` — `data` is the
app's JSON, stored verbatim.

`entryPut` is a **BLIND upsert**: an older write overwrites a newer one, because
by the time a write reaches the bridge the app has already decided who wins
(`src/domain/merge.ts`). A bridge that merged would hide an app that forgot to.

**No `entriesChanged` event.** `entryPut` is a plain write and emits nothing;
the app refreshes explicitly, because it is the app that knows what changed.

### Send ([`KIT_API.md` §5](https://github.com/barrelmaker97/obscura-native/blob/240f526/docs/KIT_API.md))

| Method | Args | Returns | Platforms |
|---|---|---|---|
| `sendEntry(recipientUserIds, modelKey, entryId, sentAt, payloadJson)` | string[], string, string, number, string | `void` | both |

Implementations MUST:

- Fan out to every device of every listed userId, **plus the author's own other
  devices**, and exclude the sending device. A caller cannot opt out of
  self-sync and cannot accidentally encrypt to itself.
- Resolve nothing. An empty `recipientUserIds` is a legitimate self-sync, not an
  error.
- Resolve when the submission is durably queued, not when delivered. Reject only
  when the send reached **nobody** — a partial failure is best-effort by design.

### Typing signals

| Method | Args | Returns | Platforms |
|---|---|---|---|
| `sendTyping(modelKey, conversationId)` | string, string | `void` | both |
| `stopTyping(modelKey, conversationId)` | string, string | `void` | both |
| `observeTyping(modelKey, conversationId)` | string, string | `void` | both |
| `stopObservingTyping(modelKey, conversationId)` | string, string | `void` | both |

While an observation is active, the bridge emits
[`typingChanged`](#typingchanged) whenever the typer set for that
conversation changes.

Signals are **droppable** (KIT_API §4): ephemeral by design, never inbox rows.
The typing API derives its audience from a canonical two-party
`conversationId` and sends nothing when that audience cannot be resolved.

### Attachments (path-based)

Bytes never cross the bridge. `uploadAttachment` reads from a local file path;
`downloadAttachment` decrypts to a cache file and returns its absolute path.

| Method | Args | Returns | Platforms |
|---|---|---|---|
| `uploadAttachment(filePath)` | string | `{ id, contentKey, nonce }` | both |
| `downloadAttachment(id, contentKey, nonce)` | strings | absolute file path | both |

The app stores `{id, contentKey, nonce}` inside its own payload; the kit treats
them as opaque. Note the coupling: attachment blobs expire server-side at 30
days while inbox rows have no expiry, so an unconsumed row can outlive its media.

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
| `requestPushPermission()` | — | `boolean` (granted) | both; token event Android only |
| `registerPushToken(token)` | string | `void` | both |

An implementation of `requestPushPermission` is complete only when it can do
all of the following:
1. Trigger the platform-native permission UI if not already decided.
2. Fetch the platform push token (FCM on Android, APNs/FCM-via-APNs on iOS).
3. Deliver the token via a [`pushTokenReceived`](#pushtokenreceived) event.

Android implements all three steps. iOS currently implements permission and
accepts a caller-supplied token through `registerPushToken`, but token
acquisition and `pushTokenReceived` delivery are not wired.

Both implementations resolve `true` only on an actual OS grant. Android's
permission request does not fetch a token after denial, but Firebase
`onNewToken` can still emit independently of that flow; JS currently registers
every token event. Neither bridge deletes the server device or token on logout.
iOS must use the same event flow once token forwarding exists.

### Deep linking

| Method | Args | Returns | Platforms |
|---|---|---|---|
| `getLaunchIntent()` | — | `{ screen: string } \| null` | both |

`getLaunchIntent` returns the cold-start deep-link target and consumes it
(repeat calls return null). Called once by JS on app mount. Warm-start
deep-links (app already running, notification tapped) arrive via the
[`launchedFrom`](#launchedfrom) event instead — the bridge isn't built yet
at cold start so the pull API is the only way to learn about that case.

The current schema is a single `screen` string. Platform status:
- Android: read intent extras (`intent.getStringExtra("screen")`) in
  the host activity, hook `onNewIntent` for warm starts.
- iOS: the method and event surface exist, but notification callbacks are not
  wired; `getLaunchIntent` returns null.

### Misc

| Method | Args | Returns | Platforms |
|---|---|---|---|
| `getDebugLog()` | — | `string[]` | both |
| `setSecureScreen(enabled)` | bool | `void` | android (no-op acceptable on iOS) |
| `prewarmAudioSession()` | — | `void` | both (no-op on Android) |
| `deleteFile(path)` | string | `void` | both |
| `setClipboard(text)` | string | `void` | both |

`setSecureScreen` sets `FLAG_SECURE` on Android to prevent app previews and
screenshots. It is a no-op on iOS.

`prewarmAudioSession` warms the audio HAL so video recording starts instantly;
cold `AVAudioSession` activation on iOS costs ~1.4s. Idempotent, no-op on
Android.

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
native implementations, or it will silently never fire. `OBSCURA_EVENT_TYPES`
in that file is the canonical name list and mirrors the `BridgeEvent` enum in
`ObscuraBridgeModule.kt`.

The ten types below are the whole set.

### `connectionChanged`
`{ type: 'connectionChanged', state: ConnectionState }` — emitted whenever
the underlying WebSocket connection state transitions. JS drains the inbox and
flushes the outbox on `'connected'`: reconnect is when the server redelivers
anything it did not see acked.

### `authStateChanged`
`{ type: 'authStateChanged', state: AuthState }` — emitted on login,
logout, and pending-approval transitions. JS treats `'loggedOut'` as
"session is gone, route to AuthScreen", and `'authenticated'` as
"session is live" — which is what runs the cold-start drain after a device link
is approved.

### `authFailed`
`{ type: 'authFailed', reason: string }` — emitted when the kit's token
refresh has exhausted its retry budget. JS treats this as "session is gone,
route to AuthScreen."

### `appStateChanged`
`{ type: 'appStateChanged', state: 'active' | 'background' }` — emitted on
process-wide foreground/background transitions. Replayed once
to a freshly-bound bridge so JS sees the current state without waiting for
the next transition. JS drains on `'active'` to process work queued while it
was suspended. iOS native background wake handling is not implemented yet.

### `launchedFrom`
`{ type: 'launchedFrom', screen: string }` — emitted when a warm-start
deep-link arrives (app already running, notification tapped). For cold
starts use [`getLaunchIntent`](#deep-linking) instead.

### `friendsUpdated`
`{ type: 'friendsUpdated', friends: Friend[] }` — emitted whenever the
friend list (accepted + pending) changes. Payload is the full list — JS
splits it by status. Without this an inbound friend request would be invisible
until something polled.

### `messageReceived`
`{ type: 'messageReceived', model: string }` — emitted after an inbox row for
a remote `MODEL_SYNC` has been **persisted**. It is a wake-up, not a delivery:
the data is in the inbox, and nothing reaches the entry store until the app
drains it there. Payload is intentionally minimal. **Do not** synthesize a fake
entry id.

This emit MAY be dropped under backpressure (`NATIVE_CONTRACT.md` §0.9 rule 4) — the row is the
delivery path. That is exactly why the app also drains on cold start,
reconnect and foreground.

### `typingChanged`
`{ type: 'typingChanged', conversationId: string, typers: string[] }` —
emitted while an `observeTyping(modelKey, conversationId)` is active. `typers` is the
current set of remote display names that are typing.

### `pushTokenReceived`
`{ type: 'pushTokenReceived', token: string }` — emitted when a fresh push
token is available (after `requestPushPermission`, on cold start with a
cached token, or on rotation). JS calls `registerPushToken` in response.
Android emits this event. iOS token delivery is not wired.

### `debugLog`
`{ type: 'debugLog', message: string }` — kit-level diagnostic line. Surfaced
in the in-app Profile debug log.

## Naming / shape rules

- `type` is the discriminator, always a kebab-free camelCase string.
- Event fields are flat scalars or simple arrays. No nested objects unless
  truly necessary (`friendsUpdated.friends` is the only nested array today).
- Method args are scalars (`string`/`number`/`boolean`) or JSON strings for
  free-form objects (`entryPut(…, dataJson, …)`). This keeps the marshalling
  story identical on both platforms — and it is what keeps nested objects and
  arrays intact, since neither bridge parses them.

## Adding to the contract

1. Update [`ObscuraModule.ts`](../src/native/ObscuraModule.ts) — add the
   method/event with full types. For an event, add it to
   `OBSCURA_EVENT_TYPES` too; the `_AssertEventTypesMatch` check makes any
   drift between the list and the union a compile error.
2. Implement in `ObscuraBridgeModule.kt` (Android).
3. Implement in `ObscuraBridge.swift` **and declare it in `ObscuraBridge.m`**
   (iOS) — `RCT_EXTERN_MODULE` needs both, and a missing `.m` line is a method
   that compiles and is invisible at runtime.
4. Add a row here.
5. Mirror it in `src/native/__fixtures__/FakeObscuraBridge.ts`, the in-memory
   double the tests run against. It models the **bridge contract**, not the
   kit's internals — if a test needs it to grow a behaviour, check first that
   the behaviour is part of this document.
6. If it's a new event, verify both natives use the single `emit(type, build)`
   helper (Android) / equivalent (iOS) so payload shape doesn't drift.
