# Fable Findings — Exploratory Phase (2026-07-01)

Findings from the design/exploration phase for the five features (streaks, story replies,
rich chat media, groups-as-a-friend, and the convo unification), plus a full iOS↔Kotlin
parity audit across three layers. Repos referenced: `obscura-pix` (this repo),
`../obscura-client-kotlin` (reference kit), `../obscura-client-ios` (Swift kit),
`../obscura-client-web`, `../obscura-server`.

All file:line references are as of this date and should be re-verified before fixing.

---

## 1. Parity audit — FIX NOW (clear bug, clear correct side)

### 1.1 CRITICAL — iOS device linking broken on the receiving side
The Swift kit sends `DEVICE_LINK_APPROVAL` but has no receive handler; the message falls
into `default: break` (`obscura-client-ios/Sources/ObscuraKit/ObscuraClient.swift:1870`).
Kotlin routes and handles it fully (`ObscuraClient.kt:837`, `handleLinkApproval` at
`:997-1041`: verify challenge → import own devices → store p2p/recovery keys → import
friends → `AUTHENTICATED`). A newly linked iOS device stays `pendingApproval` forever.
Fix: port Kotlin's `handleLinkApproval` to Swift.

### 1.2 iOS multi-device self-sync fails after restart
Swift `MessengerActor.queueMessage` hard-throws when the target device is missing from the
in-memory `deviceMap` (`MessengerActor.swift:158-160`); Kotlin lazily establishes sessions
via `ensureSession` + prekey fetch (`MessengerDomain.kt:62-70,186-196`). The iOS self-sync
callers (`sendModelSync(toSelf:)` `ObscuraClient.swift:1178-1187`, `requestSync()`
`:890-893`, `pushHistoryToDevice()` `:910-911`) never pre-fetch own bundles, and
`restoreSession` maps only the current device (`:329-331`). Result: after app restart on a
multi-device account, ORM fan-out to your own other devices silently fails (broadcast
swallows the throw, `SyncManager.swift:132-136`); `requestSync()` throws outright.

### 1.3 iOS ignores in-band `failedSubmissions` — silent message loss
Swift `flushMessages` discards the response body and unconditionally returns
`(sent: batch.count, failed: 0)` (`MessengerActor.swift:183-209`, `APIClient.swift:204`).
Kotlin parses `SendMessageResponse.failedSubmissionsList` and `MessageSender` throws when
`sent == 0 && failed > 0` (`MessengerDomain.kt:89-125`, `MessageSender.kt:27-30`).
A 200-with-failures looks like total success on iOS. (Natural place to also add batch
chunking — see §4.1.)

### 1.4 Kotlin `delete()` never broadcasts — deletions resurrect
Kotlin `Model.delete()` writes a local tombstone only (`Model.kt:149-152`); Swift
broadcasts the tombstone (`Model.swift:199-209`). Same asymmetry via TTL expiry: Swift
`TTLManager` calls `model.delete` (broadcasts, `TTLManager.swift:34-58`); Kotlin cleanup is
local-only (`TTLManager.kt:31-44`). KOTLIN-side fix.

### 1.5 iOS `getAll()`/`size()` return tombstones
Swift `LWWMap.getAll/size` do not filter `isDeleted` (`LWWMap.swift:82-90`), nor does
`ModelStore.getAll` (`ModelStore.swift:90-109`). Kotlin filters (`LWWMap.kt:69-77`).
Permanent cross-platform disagreement on any deleted LWW entry.

### 1.6 iOS bridge restore connects before ORM models are defined
Pix's `ObscuraSession.swift:148-160` hand-rolls restore (via `KeychainSession`) and
connects without defining models; inbound `MODEL_SYNC` in that window hits an empty ORM.
Android defines cached models before connecting (`ObscuraSession.kt:227-247`). The Swift
kit already ships the correct routine — `restorePersistedSession()`
(`ObscuraClient.swift:1437-1470`) — which pix bypasses. Becomes acute when iOS push lands
(JS-less background wake).

### 1.7 iOS `acceptFriend` no-ops if the friend row doesn't exist
Swift uses `friends.updateStatus` (UPDATE, no-op on missing row —
`ObscuraClient.swift:804`, `FriendStore.swift:147-153`); Kotlin upserts
(`FriendshipManager.kt:41`). Accepting a friend not already in the DB silently fails on
iOS while FRIEND_RESPONSE/FRIEND_SYNC still go out.

### 1.8 Smaller fix-now items
- `appStateChanged` never replayed to a freshly bound bridge on iOS (contract:
  `BRIDGE.md:227-232`; Android replays at `ObscuraSession.kt:146`; iOS only fires on
  transitions, `ObscuraSession.swift:164-179`, and `emit()` drops pre-listener events,
  `ObscuraBridge.swift:66-71`).
- Attachment download publish not atomic on iOS: remove-then-move with a shared tmp name
  (`ObscuraBridge.swift:546-550`); concurrent downloads of the same id can reject with
  `DOWNLOAD_ERROR`. Android: rename with copy fallback (`ObscuraBridgeModule.kt:590-599`).
- `authFailed` threshold/side-effect drift: iOS kit emits at 3 failures AND flips auth to
  `loggedOut` (`ObscuraClient.swift:1988-1994`); Android emits at 5 via the pix logger and
  only disconnects (`ObscuraSession.kt:91-94`, kit `AuthManager.kt:37,268-272`).
- Kotlin `handleSentSync` lacks the `sourceUserId == userId` guard that Swift has
  (`ObscuraClient.kt:975-983` vs Swift `:1845`). KOTLIN-side fix.
- iOS `befriend` missing the self-befriend guard Kotlin has (`FriendshipManager.kt:19`).

### 1.9 Already fixed (2026-07-01, uncommitted in obscura-client-ios)
`sendFriendSync` and `sendSentSync` looped over own devices calling `sendToAllDevices`
inside the loop → N-1 duplicate full fan-outs including the sending device. Fixed: single
call with new `excludingDeviceId:` param on `sendToAllDevices`, matching Kotlin
(exclude self, one flush). `swift build` green.

---

## 2. Parity audit — DECIDE IN CONTRACT (don't patch to match; rule once, align both)

### 2.1 Group targeting — the kits genuinely disagree
- Trigger: Kotlin fires the group path whenever the model has `belongsTo`, falling through
  if members resolve empty (`SyncManager.kt:72-84`); Swift fires only on
  `syncScope == .group` and sends SELF-ONLY on empty resolution
  (`SyncManager.swift:98-103`).
- Member parsing: Kotlin accepts JSON-array-string or native list from
  `data.members`/`data.participants`, resolves as USERNAMES (`SyncManager.kt:140-162`);
  Swift accepts only native `[String]` from `members`, treats them as USERIDS filtered by
  `isFriend` (`SyncManager.swift:217-243`).
- With the documented convention (JSON-string usernames), a group message fans out from
  Android and goes to self-only from iOS.
→ The convo contract must fix: trigger condition, field name, encoding (JSON string vs
  list), identifier type (userId recommended), empty-resolution behavior, and non-friend
  filtering. Then align both kits.

### 2.2 Scoped 1:1 recipient filtering
Kotlin delivers to `conversationId` participants regardless of friend status
(`SyncManager.kt:125-138`); Swift silently drops non-accepted friends
(`SyncManager.swift:193-211`). Which is right depends on the clique rule (§5.4).

### 2.3 Entry "signatures" — not real, and different per platform
Kotlin: SHA-256 over `JSONObject({model,id,data}).toString()` — unstable key order,
no key material (`Model.kt:237-244`). Swift: SHA-256 over `"name:id:timestamp:deviceId"`
(`Model.swift:316-320`). Never verified anywhere (dead `signatureVerificationFailed`
logger hook, zero call sites). Harmless today; fatal the moment verification is added for
group enforcement. Contract must define one canonical signing form — and real enforcement
should key off the Signal-authenticated `sourceUserId` from the transport (available in
`handleIncoming`, currently ignored), not entry self-assertions.

### 2.4 LWW tie-break is non-deterministic (both platforms, identically)
Equal-timestamp writes keep whichever arrived first (`LWWMap.kt:35`, `LWWMap.swift:39`).
Add one deterministic tie-break (e.g. higher `authorDeviceId` wins) to BOTH simultaneously.

### 2.5 One-line rulings needed
- Unresolvable direct send: Kotlin throws; iOS logs + self-syncs (`SyncManager.kt:90-98`
  vs `SyncManager.swift:117-122`).
- `upsert`: Kotlin broadcasts only when the write wins and supports GSet
  (`Model.kt:82-88`); Swift always broadcasts and throws on GSet (`Model.swift:163-181`).
- `handleSync` association registration: iOS registers `belongs_to` associations on
  incoming sync (`Model.swift:255-269`); Kotlin only on local `create` (`Model.kt:56-65`).
- Null sort order: opposite ends (`QueryBuilder.kt:196-207` vs `QueryBuilder.swift:378-394`).
- Numeric query equality: Swift normalizes via double, Kotlin raw `==`
  (`QueryBuilder.swift:367-376` vs `QueryBuilder.kt:132,147-150`).
- Kotlin `ModelStore.put` nulls `ttl_expires_at` on every write (`ModelStore.kt:11-23`);
  iOS keeps TTL in a separate table. Also shared bug on BOTH: received entries never get
  TTL scheduled — synced ephemeral entries never expire on the receiver.

---

## 3. Parity audit — noted drift (not urgent)

- Per-user DB: Android keys by username, no wipe on register
  (`ObscuraSession.kt:186-196`); iOS keys by userId, wipes on register
  (`ObscuraSession.swift:115-121`). Stale-data / collision edge cases on Android.
- FRIEND_SYNC status mapping: Kotlin collapses to PENDING_RECEIVED (`ObscuraClient.kt:988`);
  Swift preserves exact status (`:1861` — Swift is more correct). Both store under own
  userId (proto carries no friend userId) — shared quirk.
- DEVICE_ANNOUNCE signature trust: Kotlin verifies against the embedded key when present;
  Swift verifies against stored `friend.recoveryPublicKey` and would reject unsigned
  announces if it were ever populated (latent).
- iOS `send()` emits legacy TEXT; Kotlin prefers ORM directMessage. Likely dead code —
  both bridges create ORM entries directly.
- `entriesChanged` emitted before promise resolution on iOS, after on Android.
- Verified non-issues: friend-code format, logout state reads, `defineModels`
  sync/ttl/private/direct parsing (belongsTo dropped on both — known), messageReceived
  model fallback.

---

## 4. Kit/system findings relevant to the feature work

### 4.1 Fan-out batching — the scale blocker
`flushMessages` (both kits, and web `messenger.js:694-742`) drains the ENTIRE queue into
one HTTP request. Server rejects >`send_batch_limit` (default 100) wholesale with 413
(`obscura-server/src/api/messages.rs:40-42`), and clients had already cleared the queue →
total silent loss. Per-device Signal encryption happens at queue time, sequentially, on a
single confined thread (`MessengerDomain.kt:36,62-87`), each cold session adding a prekey
HTTP fetch. Required: chunk into ≤limit batches, retry/re-queue partial failures, consume
results in the ORM path (currently ignored, `ObscuraClient.kt:339-342`), prewarm sessions.
NOTE: no test anywhere exercises >50 recipients; server load testing is an unchecked TODO
(`obscura-server/docs/planning/MISC.md:6`). "Tested up to 250" not found in any repo.

### 4.2 Server semantics that matter for groups
- Within an accepted batch: per-submission failures reported in a 200 (`SendMessageResponse.
  failed_submissions`); the valid remainder inserts atomically.
- Inbox cap `max_inbox_size` (default 1000) is enforced PER DEVICE, lazily (~300s worker),
  silently evicting oldest (`message_repo.rs:178-195`). High group volume can evict older
  1:1 messages on slow devices.
- Rate limit: per-IP 10 req/s burst 20; chunked group sends rarely hit it.
- Config: `OBSCURA_MESSAGING_SEND_BATCH_LIMIT`, `OBSCURA_MESSAGING_INBOX_MAX_SIZE`.

### 4.3 Sender-Key runway (for group encryption at scale)
Both kits ALREADY fully implement the libsignal SenderKeyStore against existing tables
with identical key format `name.deviceId::distributionId` (Kotlin `SignalStore.kt:198-215`
+ `SignalKey.sq:36-39`; iOS `PersistentSignalStore.swift:246-262` + table at `:60-65`).
The group cipher flow is simply never wired. Caveats: Kotlin libsignal 0.72.0 (class API:
`GroupCipher`/`GroupSessionBuilder`) vs iOS vendored 0.40.0 (free functions
`groupEncrypt`/`groupDecrypt`/`processSenderKeyDistributionMessage`) — 32 minor versions
apart; bump iOS and/or add a cross-kit interop test before trusting wire compat.

### 4.4 Attachments
Upload-once-share-key confirmed end-to-end (one blob upload per group message regardless
of member count; only key material fans out). Gaps in BOTH kits identically: no chunking
(`ChunkedContentReference` proto ships dormant in both; web has a working `ChunkedUploader`
up to 1GB), fully in-memory crypto (~2-3x file size peak RAM), no client-side size gate vs
the server 50MB cap, no thumbnails. Largest attachment ever tested: ~1KB.

### 4.5 Test seams (the "where do we mock" answer)
- Fan-out/targeting/policy: `SyncTargetingTests.kt` pattern — capture-based fakes over
  SyncManager's six injectable callbacks; 250-member topologies are cheap static maps.
  Group targeting currently has ZERO tests in either kit.
- Batching/chunking/retry: needs a fake-`APIClient` seam injected into
  MessengerDomain/MessengerActor (does not exist yet; part of the chunking work).
- Server 250-device batches: Rust harness (`tests/common.rs`) against real Postgres.
- Live e2e: kit integration suites run real accounts against `obscura.barrelmaker.dev`,
  sequentially — right-sized for a ~10-member smoke, not 250.
- JS layer: no test infra exists in pix (scripts: android/lint/start/typecheck only).
  Plan: jest + fake bridge + in-memory bus with a JS reference port of getTargets, as the
  executable spec for the convo contract.

---

## 5. Design decisions locked (see MESSAGE_CONTRACT.md when drafted)

1. **Streaks**: rolling 72h both-sides window (web `PixList.js` semantics), computed
   client-side as a pure tested function, stored in a private lww model, 🔥N badge.
2. **GIFs**: re-upload as encrypted attachment (no third-party hotlinking).
3. **Convo inversion**: every chat is a convo. `kind: 'pair'` (exactly 2 members, roster
   locked, equal authority, no kick) | `kind: 'group'` (roles: admin | member; admins edit
   roster/name/admins; anyone can leave; creator is first admin). No other modes.
4. **Clique rule (v1)**: group membership requires friendship, enforced as each member's
   LOCAL check (friend graphs are private and cross-edges unverifiable — confirmed:
   FRIEND_SYNC is own-devices-only in all three clients). UI surfaces missing edges with
   an add-friend affordance. Escape hatch: roster-scoped device resolution later, no
   contract change.
5. **Story replies**: normal message with `kind:'storyReply'` + `meta.storyId`, sent only
   to the author; renders as quoted bubble; degrades to "X commented on your story" after
   story TTL. (Web's broadcast Comments model explicitly rejected.)
6. **Rich media**: extend the message model with `kind`/`attachment`/`meta` opaque-JSON
   fields (captionMeta precedent). Big emoji = render heuristic. Audio notes need new
   bridge recorder methods (BRIDGE.md checklist + parity tracker).
7. **No scale ceiling by design**: chunked flush is mandatory kit work; SenderKey is the
   strategic path for encryption cost (runway already exists, §4.3).
8. **Two-phase removal** (roster shrink preceded by departed-marker update) so removed
   members learn of removal without kit-side union targeting.
9. **Self-referential belongs_to trick**: convo declares `belongsTo:['convo']` with
   `convoId` = own id so the convo entity targets its own roster — works because entries
   persist before broadcast. Bridge must pass `belongsTo` through `defineModelsFromJson`
   (app-repo change, both platforms — kit already accepts it).
10. **Everything lands on web eventually**; every kit/contract change mirrors to the Swift
    kit (see docs/IOS_PARITY.md).

## 6. Signal open-source groups research (primary sources, 2026-07-01)

How Signal actually does groups, and what it means for us:

### 6.1 Sender Keys — fully client-side, adoptable with ZERO server changes
- SKDM (distribution message) = `{distribution_id UUID, chain_id, iteration, chain_key,
  public signing key}`; distributed to each member device through ordinary pairwise
  Double-Ratchet sessions. The relay sees only opaque ciphertext. Steady state: ONE
  symmetric encryption + signature per group message, same bytes to all members.
- Rotation on removal is client-local: each member rotates its OWN sender key upon
  observing a removal (Signal-Android `GroupTable.kt` → `SenderKeyUtil.rotateOurKey`),
  then lazily redistributes pairwise. Age-based rotation too (default 14d, cap 90d).
- Per-device keys; own linked devices get plaintext via pairwise sent-transcript sync,
  not the sender key. Hybrid sends are normal (sender-key targets + pairwise fallback).
- Maps directly onto our kits: store/table runway already exists (§4.3). Without a
  server change we still upload N copies (same ciphertext) — the "1 upload" variant
  needs a small group-OBLIVIOUS multi-recipient endpoint (Signal's
  `PUT /v1/messages/multi_recipient`, ~48B/recipient overhead): optional server work
  that requires no group knowledge.

### 6.2 Groups V1 vs V2 — the six-year lesson that maps onto OUR design
- GV1 (2014-2020) was exactly our current convo plan: client-side roster carried
  in-band over a blind relay. Signal's documented failure modes: roster divergence
  from concurrent updates, NO enforceable permissions ("what you learn about the
  group is only what other people tell you"), and kicks that were literally
  impossible (removed member's client just ignores it; Android's GV1 processor
  merged rosters by set-union and skipped removals).
- GV2 fixed it with a group-state service that is zero-knowledge about identities
  and content (encrypted roster entries, zkgroup anonymous credentials) but DOES
  hold: plaintext roles, a revision counter (changes accepted only at revision+1 →
  serialized, race-free), server signature over each change, invite-link password
  checks, bans, and the size cap (1000, was 150 pre-sender-keys). Paper, verbatim:
  "Roles are enforced by the server, not by a cryptographic mechanism."
- Verdict table for a blind relay: sender-key crypto/rotation/multi-device = POSSIBLE
  client-side; no-history-for-new-members = free (matches our posture); serialized
  race-free roster + admin enforcement + kicks-that-stick + invite links/bans =
  NOT possible purely client-side; POSSIBLE with a small group-oblivious state
  service (knows groups exist, their size and change timing — not who/what).

### 6.3 Consequence for our pair/group design (open decision)
Our receive-time validation over LWW rosters is GV1-shaped: correct for honest
clients, unenforceable against a hostile member, and roster-divergent under races.
Options: (a) ship v1 honest-client enforcement knowing this (small trusted friend
groups — clique rule mitigates), with sender keys for scale; (b) add an
obscura-server group-state service later (Signal's exact privacy trade, made precise
in their paper) when/if admin enforcement must be real. The contract should encode
rosters as signed change entries now so (b) is a serialization upgrade, not a redesign.

## 7. Open threads

- Reconcile where "tested up to 250" happened (no trace in repos).
- Fix-now list (§1) awaiting go-ahead; device-linking handler (§1.1) first.
- Decide §6.3 (a) vs (b) — determines whether admins are honest-client or enforced.
- iOS vendored libsignal bump (0.40.0 → ~0.72.0) + cross-kit sender-key interop test
  before relying on cross-platform group ciphertext.
