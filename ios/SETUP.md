# iOS Native Bridge Setup

The React Native app bridges to ObscuraKit (Swift Package) via `ObscuraBridge.swift`.

## Link ObscuraKit

1. Open `ios/ObscuraApp.xcworkspace` in Xcode
2. Select the `ObscuraApp` project (not Pods) in the navigator
3. Go to **Package Dependencies** tab
4. Click **+** → **Add Local** → select `../../obscura-client-ios` (the ObscuraKit repo root)
5. Add `ObscuraKit` library to the `ObscuraApp` target

## Link libsignal FFI

ObscuraKit depends on `libsignal_ffi.a`. Add the library search path:

1. Select `ObscuraApp` target → **Build Settings**
2. Search for **Library Search Paths**
3. Add: `$(SRCROOT)/../../obscura-client-ios/vendored/libsignal/target/aarch64-apple-ios-sim/release` (for simulator)
4. Add: `$(SRCROOT)/../../obscura-client-ios/vendored/libsignal/target/aarch64-apple-ios/release` (for device)

## Build libsignal for iOS (if not already done)

```bash
cd ../../obscura-client-ios/vendored/libsignal
RUSTUP_TOOLCHAIN=stable CARGO_BUILD_TARGET=aarch64-apple-ios-sim ./swift/build_ffi.sh -r
```

## Verify

Build the RN app:
```bash
npx react-native run-ios --simulator "iPhone 17e"
```

The bridge should now make real ObscuraKit calls instead of stubs.
