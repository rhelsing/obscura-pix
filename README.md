# Obscura Pix

End-to-end encrypted photo messaging app. Signal Protocol encryption, disappearing content, cross-platform. Built on ObscuraKit.

React Native app with native bridges to [ObscuraKit-Swift](https://github.com/rhelsing/ObscuraKit-swift) (iOS) and [ObscuraKit-Kotlin](https://github.com/rhelsing/ObscuraKit-Kotlin) (Android).

## What it does

- Friends via shareable codes
- Encrypted chat with typing indicators
- 24-hour stories
- Ephemeral photos (Pix) — encrypted, self-destructing
- Profiles synced to friends
- Private settings (never leave your device)
- Auto-reconnect, session persistence, offline delivery

The app never touches encryption, protobufs, or WebSocket frames. Everything goes through the ObscuraKit ORM.

## Architecture

```
React Native (shared UI)
  ├── iOS:     ObscuraBridge.swift → ObscuraKit (Swift)
  └── Android: ObscuraBridgeModule.kt → ObscuraKit (Kotlin)
```

Schema defined once in `src/models/schema.ts`. Both native bridges read it — no hardcoded models on either platform.

## Setup

### Prerequisites

- Node 20+, React Native CLI
- iOS: Xcode 16+, CocoaPods, Rust (for libsignal FFI)
- Android: Android Studio, JDK 21

### Install

```bash
npm install
```

### iOS

```bash
# Build libsignal for iOS simulator (first time only):
cd ../ObscuraKit-swift/vendored/libsignal
RUSTUP_TOOLCHAIN=stable CARGO_BUILD_TARGET=aarch64-apple-ios-sim ./swift/build_ffi.sh -r

# Install pods + run:
cd ios && bundle exec pod install && cd ..
npx react-native run-ios
```

### Android

```bash
npx react-native run-android
```

## Project Structure

```
src/
  models/schema.ts        — ORM schema (single source of truth)
  native/ObscuraModule.ts — TypeScript API contract (both bridges implement this)
ios/
  ObscuraApp/ObscuraBridge.swift — Native module → ObscuraKit-iOS
  ObscuraApp/ObscuraBridge.m    — ObjC registration
android/
  .../ObscuraBridgeModule.kt    — Native module → ObscuraKit-Kotlin
  .../ObscuraBridgePackage.kt   — ReactPackage registration
App.tsx                         — UI (auth, chat, stories, profile, settings)
```

## Development

Both platforms push events reactively to JS — no polling. Friends, connection state, auth state, typing indicators, and incoming messages all use native observation streams.

JS changes hot-reload via Metro — no rebuild needed. Native changes require a rebuild.

## Dependencies

- [ObscuraKit-Swift](https://github.com/rhelsing/ObscuraKit-swift) — iOS E2E encrypted data layer
- [ObscuraKit-Kotlin](https://github.com/rhelsing/ObscuraKit-Kotlin) — Android E2E encrypted data layer
- [obscura-server](https://github.com/barrelmaker97/obscura-server) — server (dumb relay, never sees contents)
