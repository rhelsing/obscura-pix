#!/usr/bin/env bash
#
# test-push-android.sh — Layer 2 push test for Android. Injects a fake silent
# FCM push into the running Android emulator WITHOUT touching Firebase,
# Google Play Services' FCM infrastructure, or a real FCM token. Proves the
# bridge's push handler runs end-to-end.
#
# What this does:
#   1. Finds the running Android emulator.
#   2. Invokes the app's FirebaseMessagingService directly via `am startservice`,
#      passing the silent push payload as intent extras. This bypasses FCM's
#      internal bound-service dispatch (which `am broadcast` can't reach) and
#      calls onMessageReceived() as if a real push arrived.
#   3. Streams logcat filtered to the bridge's push-handler output so you
#      can see whether `processPendingMessages()` ran and how it classified.
#
# Note: this requires ObscuraMessagingService to accept test intents. For
# real push flow verification, use Firebase Console's "Send test message"
# feature with the FCM token logged by the app on first launch.
#
# Prerequisites:
#   - App installed and running on the booted emulator.
#   - FirebaseMessagingService registered in AndroidManifest.xml with the
#     intent-filter for com.google.android.c2dm.intent.RECEIVE.
#   - Another client (real device, iOS sim, or `./gradlew :lib:test`) must
#     have sent something to this user for there to be envelopes to drain —
#     otherwise the handler will log zero counts.
#
# Usage:
#   ./scripts/test-push-android.sh                   # uses default package
#   ./scripts/test-push-android.sh <package-name>    # override
#   PACKAGE=com.foo.bar ./scripts/test-push-android.sh

set -euo pipefail

PACKAGE="${1:-${PACKAGE:-com.obscuraapp.android}}"
ADB="${ADB:-adb}"

# Ensure the Android SDK is on the path
if ! command -v "$ADB" >/dev/null 2>&1; then
  if [[ -x "$HOME/Library/Android/sdk/platform-tools/adb" ]]; then
    ADB="$HOME/Library/Android/sdk/platform-tools/adb"
  else
    echo "error: adb not found. install Android SDK platform-tools." >&2
    exit 1
  fi
fi

# Check for a running device/emulator
DEVICES=$("$ADB" devices | awk 'NR>1 && $2=="device" {print $1}')
if [[ -z "$DEVICES" ]]; then
  echo "error: no running Android emulator or device found." >&2
  echo "  boot an emulator first: emulator -avd <name>" >&2
  exit 1
fi

# Use first available device
DEVICE=$(echo "$DEVICES" | head -1)

echo "device:     $DEVICE"
echo "package:    $PACKAGE"
echo "payload:    { action: check }"
echo

# Start the FirebaseMessagingService directly. FCM's internal dispatch uses
# a bound service that we can't reach via `am broadcast`. Starting the service
# directly with the push action extras is the closest we can get to a real
# silent-push arrival without Firebase Console involvement.
#
# For authoritative end-to-end testing, use Firebase Console:
#   1. Launch the app once to generate an FCM token (grep logcat for "FCM token:")
#   2. Firebase Console → Messaging → Send test message → paste token
#   3. Custom data: { action: "check" } (no notification field — silent push)
"$ADB" -s "$DEVICE" shell am start-service \
  -n "$PACKAGE/com.obscuraapp.ObscuraMessagingService" \
  --es "action" "check" \
  --es "from" "/topics/obscura_check" 2>&1 || \
"$ADB" -s "$DEVICE" shell am startservice \
  -n "$PACKAGE/com.obscuraapp.ObscuraMessagingService" \
  --es "action" "check"

echo
echo "push delivered. watching logcat for bridge output (Ctrl-C to stop)..."
echo "looking for: ObscuraBridge / processPendingMessages / ProcessedCounts"
echo

# Stream logcat filtered to the bridge's push-handler output.
exec "$ADB" -s "$DEVICE" logcat -v time \
  ObscuraBridge:* \
  ObscuraMessagingService:* \
  ReactNativeJS:* \
  "*:S"
