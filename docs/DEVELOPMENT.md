# Platform development notes

The contributor happy path and commands live in
[`CONTRIBUTING.md`](../CONTRIBUTING.md). This document records platform
constraints that are useful when setup or builds fail.

## Prerequisites

Shared:

- Node 22.11+
- Git
- `just`

Android:

- Android Studio
- JDK 21
- Android SDK 36
- Android NDK `27.1.12297006`

iOS:

- macOS 13+
- Xcode 16+
- Rust stable
- CocoaPods 1.17.0
- Homebrew `protobuf`

## Android

Set `JAVA_HOME` to JDK 21 and `ANDROID_HOME` to the installed Android SDK.
The `just android-*` recipes locate JDK 21 automatically on macOS and locate
the standard Android SDK directory on macOS or Linux. Linux users must set
`JAVA_HOME` to JDK 21. Direct `android/gradlew` commands inherit the shell
environment; use the recipes or set both variables explicitly.

The Firebase Gradle plugin requires `android/app/google-services.json`.
Compile-only builds create the checked-in stub when that ignored file is
absent. Push testing requires downloading the real configuration for
`dev.barrelmaker.obscura` from Firebase.

## iOS

The first iOS build fetches the exact libsignal commit pinned by
`obscura-native`, builds its simulator FFI, prepares the local Swift package,
and resolves CocoaPods. Those generated outputs are cached locally and
gitignored.

The simulator build does not validate APNs, background delivery, or release
signing. Physical-device builds require Apple team `KY4LCG34B8` and App Group
`group.dev.barrelmaker.obscura`.

## Checks

The Jest suite covers domain, native facade, and state behavior. It does not
cover rendered UI or physical-device behavior. CI additionally compiles
Android Release, iOS Debug, and the standalone push sender.

## Environment and data

- Both app hosts currently target `https://obscura.barrelmaker.dev`; there is
  no app-level local or staging override.
- Development accounts and messages use that server.
- Before the first public release, schema changes require clearing app data;
  prototype migrations are not retained.
