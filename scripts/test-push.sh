#!/usr/bin/env bash
#
# test-push.sh — Layer 2 push test. Injects a fake silent APNS push into the
# running iOS Simulator WITHOUT touching Apple's APNS servers, Firebase, or
# real device tokens. Proves the bridge's push handler runs end-to-end.
#
# What this does:
#   1. Finds the booted iOS simulator.
#   2. Builds a minimal APNS payload matching what obscura-server sends:
#        { "aps": { "content-available": 1 }, "data": { "action": "check" } }
#   3. Invokes `xcrun simctl push` to deliver it.
#   4. Streams the simulator's log for the bridge's push-handler output so you
#      can see whether `processPendingMessages()` ran and how it classified.
#
# Prerequisites:
#   - App installed and running on the booted simulator.
#   - App configured for Push Notifications capability (Xcode entitlements).
#   - Another client (real device, second sim, or `swift test`) must have sent
#     something to this user for there to be envelopes to drain — otherwise
#     the handler will log zero counts.
#
# Usage:
#   ./scripts/test-push.sh                # uses default bundle id
#   ./scripts/test-push.sh <bundle-id>    # override
#   BUNDLE_ID=com.foo.bar ./scripts/test-push.sh

set -euo pipefail

BUNDLE_ID="${1:-${BUNDLE_ID:-com.obscuraapp.ios}}"

# Locate a booted simulator.
BOOTED=$(xcrun simctl list devices booted | awk -F '[()]' '/Booted/ {print $2; exit}')
if [[ -z "$BOOTED" ]]; then
  echo "error: no booted iOS simulator found." >&2
  echo "  boot one first: xcrun simctl boot <udid>  (or open Simulator.app)" >&2
  exit 1
fi

# Build the payload — this MUST match obscura-server's FCM-to-APNS shape.
# NO message content; just the silent wake-up ping.
PAYLOAD_FILE=$(mktemp -t obscura-push.XXXXXX.json)
trap 'rm -f "$PAYLOAD_FILE"' EXIT

cat > "$PAYLOAD_FILE" <<'JSON'
{
  "aps": {
    "content-available": 1
  },
  "data": {
    "action": "check"
  }
}
JSON

echo "simulator:  $BOOTED"
echo "bundle id:  $BUNDLE_ID"
echo "payload:"
sed 's/^/  /' "$PAYLOAD_FILE"
echo

# Fire the push.
xcrun simctl push "$BOOTED" "$BUNDLE_ID" "$PAYLOAD_FILE"

echo "push delivered. watching log for bridge output (Ctrl-C to stop)..."
echo "looking for: ObscuraBridge / processPendingMessages / ProcessedCounts"
echo

# Stream the simulator log, filtered to likely bridge output.
# Uses the booted sim's unified log system; --predicate limits noise.
exec xcrun simctl spawn "$BOOTED" log stream \
  --level=debug \
  --predicate 'subsystem contains "Obscura" OR eventMessage contains "ObscuraBridge" OR eventMessage contains "processPendingMessages" OR eventMessage contains "ProcessedCounts"'
