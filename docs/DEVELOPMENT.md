# Development

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

## Checkout

```bash
git submodule update --init --recursive
npm ci
```

The recommended equivalent is:

```bash
just setup
```

## Android

Set `JAVA_HOME` to JDK 21 and `ANDROID_HOME` to the installed Android SDK.

For a build without real push delivery:

```bash
just android-config
just android-run
```

For push testing, replace the stub with the Firebase configuration for
`dev.barrelmaker.obscura`. The file is gitignored.

Release compile check:

```bash
just android-release
```

## iOS

Build the pinned libsignal FFI once:

```bash
brew install protobuf
sudo gem install cocoapods -v 1.17.0 -N
just ios-bootstrap
```

Prepare dependencies and run:

```bash
just ios-prepare
npx react-native run-ios
```

The simulator build does not validate APNs, background delivery, or release
signing.

## Checks

```bash
just check
```

CI additionally builds Android Release and iOS Debug.

## Environment and data

- Both app hosts currently target `https://obscura.barrelmaker.dev`; there is
  no app-level local or staging override.
- Development accounts and messages use that server.
- Before the first public release, schema changes require clearing app data;
  prototype migrations are not retained.
