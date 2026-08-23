# iOS status

The repository contains an iOS React Native scaffold and Swift bridge backed by
`obscura-native/swift`. It builds in CI and has completed a physical
Android↔iOS interoperability pass for auth, friendship, entries, typing,
attachments, Pix/view receipts, offline queues, cold starts, and reconnects.
It is not production-ready.

[`BRIDGE.md`](BRIDGE.md) is the cross-platform native contract. This file tracks
only iOS-specific status; it is not a second API specification.

## Implemented foundation

- React Native iOS project under `ios/ObscuraApp`.
- Local Swift Package dependency on the pinned `obscura-native` submodule.
- Session ownership and Keychain persistence.
- Swift `RCTEventEmitter` bridge for the shared event stream.
- Auth, friends, device linking, current-state reads, inbox, entry storage,
  explicit-audience send, typing, attachments, image utilities, clipboard,
  launch intent, app state, and debug-log bridge surfaces.
- Simulator launch through the shared TypeScript authentication flow.
- Physical Android↔iOS foreground interoperability for the current app models.

The iOS app is expected to use the same TypeScript model, audience, merge, and
drain code as Android. Native code must not duplicate those semantics.

## Remaining production gaps

### Push delivery

iOS still needs:

1. Firebase Messaging/Core dependencies.
2. APNs entitlement and a provisioned real device.
3. `FirebaseApp` and `MessagingDelegate` setup.
4. APNs-token to FCM-token forwarding.
5. `pushTokenReceived` delivery to the shared bridge.
6. Silent-wake session restore and pending-message drain.
7. Background-only generic local notifications.
8. Tap routing that carries no conversation, sender, or message identifier.

See [`PUSH_NOTIFICATIONS.md`](PUSH_NOTIFICATIONS.md) for privacy and ownership
requirements. Push delivery cannot be validated on the simulator.

### CI

The macOS CI job checks out recursive submodules, builds and caches the
libsignal simulator FFI, prepares the local Swift package, installs JS/CocoaPods
dependencies, and builds `ObscuraApp.xcworkspace` for a generic simulator.

The local SPM path resolves `../obscura-native/swift` from `ios/`. CocoaPods
environments missing `kconv` need the `nkf` gem.

### Device verification

A provisioned device has exercised authentication restore, friend acceptance,
entry round trips, typing, attachments, Pix/view receipts, disconnected queues,
cold starts, and reconnect idempotence. Remaining device work is Swift link
approval, real app background/foreground automation, FCM-via-APNs delivery,
notification privacy, and an old-to-new schema upgrade under one bundle ID.

## Build prerequisites

- macOS with Xcode and CocoaPods.
- Node dependencies installed from the lockfile.
- Repository submodules initialized recursively.
- libsignal FFI built and the local package prepared using its Swift helpers.

Do not infer production support from the build gate or foreground interop pass.
Until real-device push and release-signing tests exist, Android remains the only
production platform.
