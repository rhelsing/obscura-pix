# Development

## Prerequisites

Shared:

- Node 22.11+
- Git

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

## Android

Set `JAVA_HOME` to JDK 21 and `ANDROID_HOME` to the installed Android SDK.

For a build without real push delivery:

```bash
cp android/app/google-services.stub.json android/app/google-services.json
npm run android
```

For push testing, replace the stub with the Firebase configuration for
`dev.barrelmaker.obscura`. The file is gitignored.

Release compile check:

```bash
(cd android && ./gradlew :app:assembleRelease --no-daemon)
```

## iOS

Build the pinned libsignal FFI once:

```bash
brew install protobuf
sudo gem install cocoapods -v 1.17.0 -N
rustup target add aarch64-apple-ios-sim

export LIBSIGNAL_COMMIT=7ef4efdb85d8b2ebd77f3cf1e2b542a2115033c5
mkdir -p obscura-native/swift/vendored
git init obscura-native/swift/vendored/libsignal
git -C obscura-native/swift/vendored/libsignal remote add origin https://github.com/signalapp/libsignal
git -C obscura-native/swift/vendored/libsignal fetch --depth 1 origin "$LIBSIGNAL_COMMIT"
git -C obscura-native/swift/vendored/libsignal checkout --detach FETCH_HEAD
(
  cd obscura-native/swift/vendored/libsignal
  RUSTUP_TOOLCHAIN=stable \
    CARGO_BUILD_TARGET=aarch64-apple-ios-sim \
    BINDGEN_EXTRA_CLANG_ARGS="--target=arm64-apple-ios16.0-simulator" \
    ./swift/build_ffi.sh -r
)
```

Prepare dependencies and run:

```bash
./obscura-native/swift/dev.sh prepare
(cd ios && pod install)
npx react-native run-ios
```

The simulator build does not validate APNs, background delivery, or release
signing.

## Checks

```bash
npm test
npm run typecheck
npm run lint
```

CI additionally builds Android Release and iOS Debug.

## Environment and data

- Both app hosts currently target `https://obscura.barrelmaker.dev`; there is
  no app-level local or staging override.
- Development accounts and messages use that server.
- Before the first public release, schema changes require clearing app data;
  prototype migrations are not retained.
