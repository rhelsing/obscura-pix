# Contributing

## Workflow

Never commit directly to `main`. Create a branch, open a pull request, and wait
for the required CI jobs before merging.

The TypeScript app owns application semantics. Do not move model parsing,
audience resolution, authorization, merge, expiry, or notification policy into
the native hosts or ObscuraKit. Read [`docs/DOMAIN_CONTRACT.md`](docs/DOMAIN_CONTRACT.md)
and [`docs/BRIDGE.md`](docs/BRIDGE.md) before changing those boundaries.

Changes to the ObscuraKit API land in `obscura-native` first. After that pull
request merges, update this repository's `obscura-native` gitlink in a separate
pull request.

## Prerequisites

Install [`just`](https://github.com/casey/just), Node 22.11+, and Git. Android
work requires JDK 21, Android SDK 36, and Android NDK `27.1.12297006`. iOS work
requires macOS, Xcode 16+, Rust stable, CocoaPods 1.17.0, and `protoc`.

On macOS:

```bash
brew install just protobuf
sudo gem install cocoapods -v 1.17.0 -N
```

Node and Java versions are recorded in [`.nvmrc`](.nvmrc) and
[`.java-version`](.java-version). Gradle recipes reject other Java versions and
automatically locate JDK 21 through `java_home` on macOS.

## Setup

```bash
git clone --recurse-submodules https://github.com/rhelsing/obscura-pix.git
cd obscura-pix
just setup
just doctor
```

For Android:

```bash
just doctor-android
just android-config
just android-release
```

`android-config` creates the checked-in compile-only Firebase stub only when a
real `android/app/google-services.json` is absent. Real push testing requires
downloading that ignored file from the Firebase project; never commit it.

For iOS:

```bash
just doctor-ios
just ios-build
```

The first iOS bootstrap fetches the Native-pinned libsignal commit and builds
its simulator FFI. Later runs reuse that output. Physical-device signing
requires access to Apple team `KY4LCG34B8` and App Group
`group.dev.barrelmaker.obscura`.

## Checks

```bash
just check
just android-release
just ios-build
just push-sender-build
```

CI invokes these same recipes in separate jobs so failures remain easy to
identify and independent jobs remain parallel.
