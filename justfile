set shell := ["bash", "-euo", "pipefail", "-c"]

# List available recipes.
default:
    @just --list

# Install submodules and JavaScript dependencies.
setup:
    git submodule update --init --recursive
    npm ci

# Install JavaScript dependencies from the lockfile.
install:
    npm ci

# Verify shared JavaScript prerequisites.
doctor:
    @command -v git >/dev/null || { echo "error: git is required" >&2; exit 1; }
    @command -v node >/dev/null || { echo "error: Node 22.11+ is required" >&2; exit 1; }
    @command -v npm >/dev/null || { echo "error: npm is required" >&2; exit 1; }
    @node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 11)) { console.error(`error: Node 22.11+ is required; found ${process.versions.node}`); process.exit(1); }'
    @echo "Shared Obscura prerequisites are ready."

# Verify Android prerequisites.
doctor-android: doctor
    @./scripts/run-with-java-21.sh java -version >/dev/null 2>&1
    @test -n "${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}" || { echo "error: set ANDROID_HOME to Android SDK 36" >&2; exit 1; }
    @test -d "${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}/platforms/android-36" || { echo "error: Android SDK 36 is required" >&2; exit 1; }
    @echo "Android prerequisites are ready."

# Verify iOS prerequisites.
doctor-ios: doctor
    @test "$(uname -s)" = "Darwin" || { echo "error: iOS builds require macOS" >&2; exit 1; }
    @command -v xcodebuild >/dev/null || { echo "error: Xcode command-line tools are required" >&2; exit 1; }
    @command -v rustup >/dev/null || { echo "error: rustup is required" >&2; exit 1; }
    @command -v protoc >/dev/null || { echo "error: protoc is required" >&2; exit 1; }
    @command -v pod >/dev/null || { echo "error: CocoaPods 1.17.0 is required" >&2; exit 1; }
    @echo "iOS prerequisites are ready."

# Run Jest tests.
test:
    npm test

# Type-check app and test sources.
typecheck:
    npm run typecheck

# Run ESLint.
lint:
    npm run lint

# Run every JavaScript CI gate.
check: test typecheck lint

# Create a compile-only Firebase config when no real config exists.
android-config:
    @if [[ ! -f android/app/google-services.json ]]; then cp android/app/google-services.stub.json android/app/google-services.json; echo "Created ignored Firebase stub for compile-only builds."; else echo "Using existing android/app/google-services.json."; fi

# Run the Android app.
android-run: android-config
    npm run android

# Assemble the Android release APK.
android-release: android-config
    cd android && ../scripts/run-with-java-21.sh ./gradlew :app:assembleRelease --no-daemon

# Clean generated app/camera outputs and assemble a fresh release APK.
android-clean-release: android-config
    cd android && ../scripts/run-with-java-21.sh ./gradlew :react-native-vision-camera:clean :app:clean :app:assembleRelease --no-daemon

# Build the standalone encrypted push sender.
push-sender-build:
    cd tools/push-sender && ../../scripts/run-with-java-21.sh ./gradlew installDist --no-daemon

# Fetch and build the pinned iOS Simulator libsignal FFI.
ios-bootstrap:
    ./obscura-native/swift/scripts/bootstrap-libsignal.sh ios-sim

# Prepare ObscuraKit's local Swift package.
ios-native-prepare: ios-bootstrap
    ./obscura-native/swift/dev.sh prepare

# Resolve CocoaPods.
ios-pods:
    cd ios && pod install

# Prepare all native iOS dependencies.
ios-prepare: ios-native-prepare ios-pods

# Build the iOS app for a generic simulator.
ios-build: ios-prepare
    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.bareRepository GIT_CONFIG_VALUE_0=all xcodebuild -workspace ios/Obscura.xcworkspace -scheme Obscura -destination 'generic/platform=iOS Simulator' -configuration Debug CODE_SIGNING_ALLOWED=NO build

# Complete Android onboarding after cloning.
setup-android: setup android-config

# Complete iOS onboarding after cloning.
setup-ios: setup ios-prepare
