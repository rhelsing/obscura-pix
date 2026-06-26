#!/usr/bin/env bash
# Tail Obscura-relevant logcat lines on the connected Android device.
# Usage: ./logcat.sh           # follow
#        ./logcat.sh -c        # clear first
#        ./logcat.sh --dump    # dump current buffer once

set -euo pipefail
export PATH="$HOME/Android/Sdk/platform-tools:$PATH"

TAGS=(
  ObscuraBridge:V
  ObscuraMessagingService:V
  ObscuraApp:V
  NotificationHelper:V
  FirebaseMessaging:V
  FirebaseInstanceId:V
  FA:I
  ReactNativeJS:V
  ReactNative:V
  AndroidRuntime:E
  '*:S'
)

if [[ "${1:-}" == "-c" ]]; then
  adb logcat -c
  shift || true
fi

if [[ "${1:-}" == "--dump" ]]; then
  adb logcat -d "${TAGS[@]}"
else
  adb logcat "${TAGS[@]}"
fi
