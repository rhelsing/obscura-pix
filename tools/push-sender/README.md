# push-sender

End-to-end push notification tester. Registers a throwaway Obscura user,
befriends your phone account, and sends real encrypted TEXT messages —
exercising the full server → FCM → device push pipeline.

## Build

```bash
./gradlew installDist
ln -sf "$PWD/build/install/push-sender/bin/push-sender" ~/bin/push-sender  # optional
```

State (sender identity + Signal session DB) is persisted in
`~/.cache/obscura-push-tester/`. Delete that directory to start over.

## Workflow

```bash
# 1. Register a sender once
push-sender init
#   → prints userId/username; saved to ~/.cache/obscura-push-tester/sender.json

# 2. Send a friend request to your phone account
#    (find your userId in the Obscura app or postgres)
push-sender befriend 019ef27a-dd95-782b-b2e5-349bc3486398 <yourUsername>

# 3. Open the app on the phone, accept the friend request.

# 4. Send a test message (also exercises the push path when app is killed)
push-sender send <yourUsername> "Hello from push-sender"

# Burst test
push-sender ping <yourUsername> 5
```

To verify the killed-app code path: `adb shell am force-stop com.obscuraapp.android`
then `push-sender ping <yourUsername> 1` and watch `./logcat.sh`.

## Logcat helper

```bash
./logcat.sh -c    # clear and follow Obscura-relevant tags
./logcat.sh --dump
```

Tags filtered: `ObscuraBridge`, `ObscuraMessagingService`, `NotificationHelper`,
`FirebaseMessaging`, `ReactNativeJS`, `AndroidRuntime`.

## Notes

- Targets `OBSCURA_API_URL` (default `https://obscura.barrelmaker.dev`).
- Uses `com.obscura:obscura-kit:0.1.0` from mavenLocal. If you change the kit,
  re-publish with `./gradlew publishToMavenLocal -x test` in ObscuraKit-Kotlin.
