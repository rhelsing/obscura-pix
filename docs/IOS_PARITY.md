# iOS status

The repository contains an iOS React Native scaffold and Swift bridge backed by
`obscura-native/swift`. It builds and runs the shared authentication UI on a
simulator when native dependencies are available, but it is not production-ready
and has no CI job.

[`BRIDGE.md`](BRIDGE.md) is the cross-platform native contract. This file tracks
only iOS-specific status; it is not a second API specification.

## Implemented foundation

- React Native iOS project under `ios/ObscuraApp`.
- Local Swift Package dependency on a sibling `obscura-native` checkout.
- Session ownership and Keychain persistence.
- Swift `RCTEventEmitter` bridge for the shared event stream.
- Auth, friends, device linking, current-state reads, inbox, entry storage,
  explicit-audience send, typing, attachments, image utilities, clipboard,
  launch intent, app state, and debug-log bridge surfaces.
- Simulator launch through the shared TypeScript authentication flow.

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

There is no iOS build job. A macOS job must:

1. Check out `barrelmaker97/obscura-native` beside this repository, including
   its submodules.
2. Build the vendored libsignal FFI for the simulator.
3. Run `obscura-native/swift/dev.sh prepare` to create the uniquely named
   local libsignal package used by SwiftPM.
4. Run `npm ci` and `pod install`.
5. Build `ObscuraApp.xcworkspace` for a generic iOS Simulator destination.

The local SPM path expects `../../obscura-native/swift`; CI must reproduce that
layout. CocoaPods environments missing `kconv` need the `nkf` gem.

### Device verification

A provisioned device must exercise authentication restore, friend/device link
approval, message round trips, attachments, app foreground/background
transitions, FCM-via-APNs delivery, and notification privacy.

## Build prerequisites

- macOS with Xcode and CocoaPods.
- Node dependencies installed from the lockfile.
- `obscura-native` checked out beside this repo with submodules.
- libsignal FFI built and the local package prepared using its Swift helpers.

Do not infer production support from a simulator build. Until CI and real-device
push tests exist, Android remains the only production platform.
