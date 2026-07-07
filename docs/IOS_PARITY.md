# iOS parity tracker

Obscura Pix has a **working iOS foundation** committed under `ios/`: a fresh RN
0.86 scaffold, `ObscuraBridge.swift` implementing [`BRIDGE.md`](BRIDGE.md), and
the [`ObscuraKit-swift`](https://github.com/rhelsing/ObscuraKit-swift) Swift kit
wired as a local SPM package. It builds, launches, and runs the auth flow on the
simulator (see **Port status** below). An earlier broken stub `ios/` was deleted
in `85824ac`; this foundation was scaffolded fresh in `5fb3fd3`.

[`BRIDGE.md`](BRIDGE.md) is the cross-platform contract and single source of
truth; Android's `ObscuraBridgeModule.kt` is the reference implementation.

**The gap: the foundation is not yet reproducible.** The Xcode project points
its SPM package and libsignal search paths at a machine-local
`../../obscura-client-ios` — a directory that exists on no machine but the
original author's. The real Swift kit is `ObscuraKit-swift`. Closing this gap —
repoint to a sibling `ObscuraKit-swift` checkout (mirroring Android's
`OBSCURA_KIT_PATH` composite build) plus a `macos-26` iOS CI job that builds the
libsignal FFI — is the top remaining item. **All of this is macOS-only**
(Xcode / `xcodebuild` / CocoaPods / simulator / code-signing) and must be
authored/verified on a Mac or through the macOS CI runner, not on Linux.

This file tracks what the Swift bridge must do to stay in parity. Keep it
current as Android-side or contract changes land.

## Deltas from recent work to replicate in the Swift bridge

- **`setClipboard(text)`** — bridge method added in `353aa86`. iOS:
  `UIPasteboard.general.string`.
- **`requestPushPermission()` only-on-grant semantics** (`a276614`, H1):
  resolve `true` only on an actual OS grant, fetch the push token only on
  grant, deliver it via the `pushTokenReceived` event, and never register a
  token for a denied device. iOS `UNUserNotificationCenter.requestAuthorization`
  returns the granted flag directly (simpler than Android's permission-callback
  path), but the only-on-grant rule still holds.
- **`authorDeviceId` / `getDeviceId()` correctness** (`c24c27a`, C3): the real
  bug was kit-side — `ObscuraClient` stamped `authorDeviceId=""`, breaking the
  "friend profiles" filter. Fixed in **ObscuraKit-Kotlin commit `4c999b0`**
  (deviceId became a `() -> String` provider read on every create).
  **ObscuraKit-Swift needs the same fix**, or profile filtering breaks on iOS too.
- **Notification channel id** (`a276614`, H3/H4) is Android-specific (no iOS
  equivalent), but ensure any non-silent push fallback on iOS posts correctly.

## Shared JS fixes — no iOS work needed

These are cross-platform JS and already covered: RecipientPicker
cleanup-on-success-only (H2), StoriesScreen oldest-first ordering + progress
bar (`357e922`), ChatListScreen dead `_deleted` filter removal (H5), and the
memoization / keyboard tweaks (`353aa86`).

## Core contract items still unbuilt on iOS

Straight from [`BRIDGE.md`](BRIDGE.md) — the Swift bridge must satisfy all of it.
The ones with iOS-specific requirements:

- **Path-based attachments** with atomic publish (write temp file, then rename).
- **`resizeImage`** honoring EXIF orientation, bounded peak memory
  (`ImageIO` + `kCGImageSourceThumbnailMaxPixelSize`), reject `maxDim <= 0`,
  clamp quality, surface OOM as a rejection.
- **`writeTestImage`** for the no-camera fallback.
- **Deep linking** — `getLaunchIntent` (cold start, consume-once) plus the
  `launchedFrom` and `appStateChanged` events.
- **`setSecureScreen`** — iOS no-op is acceptable; blur-on-background is the
  suggested future behavior.
- All ORM mutations (`createEntry`/`upsertEntry`/`deleteEntry`) must emit
  `entriesChanged`.

## ObscuraKit-swift (the Swift kit) is behind the Kotlin kit

> Note: this section's history refers to the Swift kit by an old local checkout
> name, `obscura-client-ios`. The actual repo is
> [`ObscuraKit-swift`](https://github.com/rhelsing/ObscuraKit-swift); read any
> `obscura-client-ios` path below as a checkout of that repo. Items #16/#17/#18
> below have since merged into `ObscuraKit-swift` main.

API audit (task #1) — the Swift kit (`Package.swift` product `ObscuraKit`) covers
auth, state reads, friends/codes, device linking, ORM (`defineModelsFromJson`,
`model(name).create/upsert/delete`), typing (`ModelSignal.typing/observeTyping`),
push token registration, and ships a purpose-built `observeEvents()` stream "for
the bridge." But it lags `obscura-client-kotlin` in four ways that block full
`BRIDGE.md` parity — the iOS port is **not** purely a pix-repo bridge job:

1. **deviceId is snapshot-at-schema-time, not a per-create provider.**
   `Model.deviceId` is set once in `ObscuraClient.schema()` (`model.deviceId =
   self.deviceId ?? ""`, ObscuraClient.swift:1157) and read on every
   `create`/`upsert` (Model.swift:136,173). Kotlin fixed this at the source in
   `4c999b0` (deviceId became `() -> String`). Mitigation: pix calls
   `defineModels` gated behind `authed` (store.ts:222), so as long as the Swift
   bridge/session populates `client.deviceId` (via `restorePersistedSession` on
   cold start, and inside register/login) **before** reporting
   `authState=authenticated`, entries stamp correctly. Otherwise the C3
   "own profile under friend profiles" bug reappears on iOS.
2. ✅ **DONE (task #16):** added `ObscuraClient.uploadAttachment(_ plaintext) ->
   (id, contentKey, nonce)` — encrypts via `AttachmentCrypto`, uploads ciphertext
   via `api.uploadAttachment`, returns the reference triple without sending a
   CONTENT_REFERENCE. Download already covered by `downloadDecryptedAttachment`.
3. ✅ **DONE (task #17):** added `model: String?` to `ReceivedMessage` (set to
   `clientMsg.modelSync.model` for MODEL_SYNC); `observeEvents()` now emits the
   real model name instead of hardcoded `"directMessage"`.
4. ✅ **DONE (task #18):** added `ObscuraEvent.authFailed(reason:)` +
   `observeAuthFailed()` stream, emitted on the token-refresh-exhausted path
   (`consecutiveFailures >= 3`) before going `.loggedOut`.

Kit verified with `swift build` (Build complete) + all test sources compile.
Caveat: `swift build --build-tests` fails to LINK on this machine with
`library 'signal_ffi' not found` (vendored libsignal not prebuilt) — confirmed
**pre-existing** (baseline without these changes fails identically). CI (task
#15) must build the vendored libsignal before running kit tests.

Also minor: Swift `FriendActor.getPending()` queries only `pendingReceived`
(FriendStore.swift:140) — confirm `pending_sent` friends still surface for
`getPendingRequests`.

## Toolchain note (scaffold)

`pod install` initially crashed with `cannot load such file -- kconv`: Homebrew
Ruby (`/opt/homebrew/opt/ruby`, 4.0.2, arm64 — the Ruby that `pod` actually
runs on) dropped the `kconv` stdlib that CocoaPods 1.16.2 still requires. The
other Rubies on the machine don't help (rvm 3.2.2 is x86_64 → wrong-arch native
exts; system 2.6.10 is < 2.7, too old for modern CocoaPods). Fix that worked:
`/opt/homebrew/opt/ruby/bin/gem install nkf` — the `nkf` gem ships `kconv.rb`
plus an arch-matching `nkf.bundle`, so `require 'kconv'` resolves. CI (task #15)
will need the same on its macOS runner. iOS bundle id set to `com.obscuraapp.ios`
(matches the Firebase plist); node_modules was stale at 0.84.1 and re-synced to
the lockfile's 0.86.0 before `pod install`.

## Port status

Foundation built & verified (all `xcodebuild` green on arm64 simulator):
- Kit parity changes #16/#17/#18 — done, committed to obscura-client-ios `e7bdb53`.
- `ios/` scaffold (RN 0.86, bundle `com.obscuraapp.ios`, deployment target 16.0
  to match ObscuraKit) — builds.
- ObscuraKit wired as local SPM package + libsignal search paths — **compiles &
  links `signal_ffi` into the app** (the step the old scaffold never reached).
- `ObscuraApp/ObscuraSession.swift` + `KeychainSession.swift` — client owner,
  Keychain persistence, restore-on-launch (deviceId-before-auth ordering).
- `ObscuraApp/ObscuraBridge.swift` (+ `ObscuraBridge.m`) — `RCTEventEmitter`
  relaying the kit's `observeEvents()` to the single `ObscuraEvent` stream,
  plus the RPC methods below.

Bridge RPC methods implemented + compiling (each `xcodebuild` green):
- Auth + state-reads (register/loginSmart/loginAndProvision/connect/disconnect/
  logout/get*) — onlyDevice maps to deviceMismatch (not in the JS union).
- Friends + device linking (befriend/accept/getFriendCode/addFriendByCode/
  getFriends/getPendingRequests/generateLinkCode/validateAndApproveLink).
- ORM (defineModels/createEntry/upsertEntry/queryEntries/allEntries/deleteEntry)
  — mutations emit `entriesChanged`.
- Typing (sendTyping/stopTyping/observeTyping/stopObservingTyping → typingChanged),
  on the "directMessage" model. Needed kit task #19 (untyped-Model typing).
- Attachments (uploadAttachment/downloadAttachment) — atomic temp+rename cache,
  sanitized ids, base64 key/nonce over the bridge, bytes via files.
- Image (resizeImage EXIF/OOM-bounded via ImageIO thumbnail; writeTestImage).
- Misc (setClipboard/deleteFile/setSecureScreen[no-op]) + camera/mic Info.plist.
- Deep link + debug log (getLaunchIntent consume-once; getDebugLog from a
  BridgeLogger ring buffer; launchedFrom hook for warm-start; appStateChanged
  wired from ObscuraSession lifecycle).

Remaining:
- **Push (#11)** — the big one. Android uses FCM, so iOS parity needs the
  Firebase iOS SDK (FirebaseMessaging) + APNs entitlement + AppDelegate wiring
  (FirebaseApp.configure, Messaging delegate, registerForRemoteNotifications,
  APNs→FCM token → pushTokenReceived, silent-push receiver, local notifications).
  Untestable on the simulator — needs a real device + Apple provisioning.
- **#14** device/sim run exercising the JS flows (the real behavioral test).
- **#15** iOS CI job + Dependabot (CI must `gem install nkf` + build libsignal FFI).

Project edits were scripted with the `xcodeproj` gem (installed for Homebrew
Ruby); re-runnable.

## #14 — simulator run result

Ran on an iPhone 17 simulator (iOS 26, arm64) with Metro: the app **builds,
installs, launches, and renders the real shared-`src/` auth screen** ("OBSCURA —
encrypted everything", sign up / log in). No redbox; the bootstrap's
`getAuthState()` bridge round-trip routed correctly to AuthScreen. Because the
bridge is registered via `RCT_EXTERN_MODULE` (load-time registration), this is
the *real* native module, not the JS noop-Proxy fallback — i.e. the bridge is
live at runtime, not merely compiling.

Verified on the simulator: build → launch → **authenticated main UI** (header,
profile avatar, chat tab) — i.e. the full auth flow (register/login → session
persist → Keychain restore → connect) works end-to-end against the live server.
`requestPushPermission()` fires the real `UNUserNotificationCenter` prompt. No
redbox, no JS errors.

Fixed during #14: the JS bootstrap calls `requestPushPermission()` unconditionally,
so the deferred-#11 missing method redboxed every launch. Implemented the push
permission + token-registration bridge methods (commit on `ios/foundation`).

Still needs a real device / deeper interaction: chat/stories/pix message
round-trips, and push *delivery* (#11 FCM/APNs, simulator-incompatible). Boot +
launch recipe:
`xcrun simctl boot <id>`; `npx react-native start`; build with
`-destination 'id=<id>'`; `simctl install` + `simctl launch com.obscuraapp.ios`.

## Push (#11) — implementation checklist

Android registers an **FCM** token (`FirebaseMessaging.getInstance().token`) and
the server/`tools/push-sender` send via FCM. For iOS to receive the same pushes,
use **FCM-via-APNs** (not raw APNs), so the token registered with the server is
an FCM registration token like Android's.

1. **Firebase iOS SDK** — add `FirebaseMessaging` (+ `FirebaseCore`) to the
   `Podfile` (`pod 'FirebaseMessaging'`) and `pod install`. `GoogleService-Info.plist`
   is already in `ios/ObscuraApp/` (gitignored; fetch per env).
2. **APNs entitlement** — add `aps-environment` (development/production) via an
   `ObscuraApp.entitlements` file + Signing & Capabilities. Requires an Apple
   Developer team + provisioning profile with Push Notifications enabled.
3. **AppDelegate wiring** —
   - `FirebaseApp.configure()` in `didFinishLaunchingWithOptions`.
   - `Messaging.messaging().delegate = self`; `UNUserNotificationCenter.current().delegate = self`.
   - `application.registerForRemoteNotifications()` after permission grant.
   - `didRegisterForRemoteNotificationsWithDeviceToken` → `Messaging.messaging().apnsToken = deviceToken`.
   - `messaging(_:didReceiveRegistrationToken:)` → forward the FCM token to the
     bridge → emit `pushTokenReceived`.
   - silent push (`content-available`) in `didReceiveRemoteNotification` →
     drive `ObscuraSession` to drain pending messages (mirror Android
     `ObscuraMessagingService` + `onPushWake`).
   - local-notification posting when backgrounded (mirror `NotificationHelper`).
   - notification tap → set `ObscuraBridge.pendingLaunchScreen` (cold start) or
     call `ObscuraBridge.deliverLaunchedFrom(_:)` (warm start) — hooks already exist.
4. **Bridge methods** — `requestPushPermission` (`UNUserNotificationCenter
   .requestAuthorization`; resolve `true` ONLY on grant, then
   `registerForRemoteNotifications`; resolve `false` on deny, no token) and
   `registerPushToken(token)` → `client.registerPushToken(token)`.
5. **Cannot be tested on a simulator** — APNs needs a real device + provisioning.

## iOS CI (#15) — checklist

Mirror the existing `android` job in `.github/workflows/ci.yml`, on a `macos-26`
runner. The single best template is **`ObscuraKit-swift`'s own
`.github/workflows/ci.yml`**, which already solves the libsignal problem
reproducibly (clone `signalapp/libsignal` at a pinned version, Rust-build the FFI
with `./swift/build_ffi.sh -r`, cache it).

1. Checkout pix, plus a sibling checkout of the Swift kit —
   `rhelsing/ObscuraKit-swift` at `../ObscuraKit-swift` (submodules recursive,
   for its `proto/` submodule). This is the iOS analog of the android job's
   `ObscuraKit-Kotlin` sibling checkout + `OBSCURA_KIT_PATH`. GRDB no longer
   needs a `grdb-cipher-fork` sibling — the kit now pins the public
   `duckduckgo/GRDB.swift @ 2.4.2-1` transitively.
2. Build the libsignal FFI in the kit checkout: `./App/build_ffi_ios.sh`
   (Rust + `rustup target add aarch64-apple-ios aarch64-apple-ios-sim`), and
   cache it keyed on the pinned libsignal version. (Copy the kit CI's cache step.)
3. `npm ci`; `cd ios && pod install`. If the runner's Ruby lacks `kconv`
   (CocoaPods dependency), `gem install nkf` first (it ships `kconv.rb`).
4. `xcodebuild -workspace ios/ObscuraApp.xcworkspace -scheme ObscuraApp
   -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' build`
   (the project already sets `EXCLUDED_ARCHS[sim]=x86_64` + deployment 16.0).
5. Dependabot: add a CocoaPods (and/or Swift Package) ecosystem entry.

> Prerequisite for this CI job: the pbxproj must first be repointed from
> `obscura-client-ios` to `../../ObscuraKit-swift` (see the integration recipe
> below). Until then the SPM local path resolves on no CI runner.

## Kit integration recipe

To wire `ObscuraKit-swift` into pix's `ios/ObscuraApp.xcodeproj` reproducibly
(sibling checkout, mirroring Android's composite build):

1. **Local SPM package** — `XCLocalSwiftPackageReference` with `relativePath`
   pointing at the kit root. With the kit checked out as a sibling of `pix`,
   from `pix/ios/` that's `../../ObscuraKit-swift`. Add an
   `XCSwiftPackageProductDependency` for product `ObscuraKit`, attach it to the
   app target's `packageProductDependencies` + Frameworks build phase. SPM
   resolves the kit's transitive deps automatically (the public
   `duckduckgo/GRDB.swift` pin and the vendored `LibSignalClient`).
2. **libsignal linking** — set `LIBRARY_SEARCH_PATHS` on the app target:
   - simulator → `$(PROJECT_DIR)/../../ObscuraKit-swift/vendored/libsignal/target/aarch64-apple-ios-sim/release`
   - device    → `$(PROJECT_DIR)/../../ObscuraKit-swift/vendored/libsignal/target/aarch64-apple-ios/release`
   (the `LibSignalClient` SPM product links `-lsignal_ffi`; it just needs the path.)
3. **Build the FFI** — `libsignal_ffi.a` comes from
   `../../ObscuraKit-swift/App/build_ffi_ios.sh` (Rust/cargo, targets
   `aarch64-apple-ios` + `aarch64-apple-ios-sim`; needs `vendored/libsignal`
   cloned first — the kit's CI does this). Build the device `.a` before an
   on-device/TestFlight build.

> SPM caveat vs Android: there is no `XCLocalSwiftPackageReference` env-var
> override analogous to `OBSCURA_KIT_PATH` — the `relativePath` is static in the
> pbxproj. A sibling checkout at the documented path (or a symlink) is the
> convention; CI checks the kit out to match.

## Infra parity gaps

- **CI** (`.github/workflows/ci.yml`) runs typecheck + lint + an `android`
  build job only — there is **no iOS job yet**. The android job checks out
  `ObscuraKit-Kotlin` as a sibling and builds it via the Gradle composite build
  (`OBSCURA_KIT_PATH`). The iOS job should mirror that: sibling `ObscuraKit-swift`
  checkout + libsignal FFI build (see the iOS CI checklist above).
- **Dependabot** covers npm + gradle ×2 + github-actions only. Add the
  CocoaPods/SPM ecosystem once the iOS build is reproducible/CI-gated.

## Cleanup

- ✅ **DONE:** `ios/ObscuraApp/GoogleService-Info.plist` is no longer git-tracked
  (matches the Android `google-services.json` fetch-per-env convention). The
  Firebase iOS config for project `obscura-af88b` is re-downloadable from the
  Firebase console. The rest of `ios/` on disk is gitignored Xcode/Pods build junk.
