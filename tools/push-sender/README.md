# push-sender

End-to-end push notification tester. Registers a throwaway Obscura user,
befriends your phone account, and sends real encrypted `directMessage` entries —
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

# 2. Send a friend request to your phone account.
#    NOTE: this takes a raw userId, NOT the app's share code. The code shown in
#    the app is base64 of {"u":"<userId>","n":"<username>"} — decode it first:
#      echo '<code>' | base64 -d
push-sender befriend 019ef27a-dd95-782b-b2e5-349bc3486398 <yourUsername>

# 3. Open the app on the phone, accept the friend request.

# 4. Send a test message (also exercises the push path when app is killed)
push-sender send <yourUsername> "Hello from push-sender"

# Burst test
push-sender ping <yourUsername> 5
```

To verify the killed-process path, background the app and remove it from
recents, then run `push-sender ping <yourUsername> 1` and watch `./logcat.sh`.
Do not force-stop the app; Android suppresses FCM until a force-stopped app is
opened again.

## Logcat helper

```bash
./logcat.sh -c    # clear and follow Obscura-relevant tags
./logcat.sh --dump
```

Tags filtered: `ObscuraBridge`, `ObscuraMessagingService`, `NotificationHelper`,
`FirebaseMessaging`, `ReactNativeJS`, `AndroidRuntime`.

## Notes

- Targets `OBSCURA_API_URL` (default `https://obscura.barrelmaker.dev`).
- The kit is a **Gradle composite build** against the pinned `obscura-native`
  submodule (`settings.gradle.kts` → `../../obscura-native/kotlin`), matching
  `android/settings.gradle`. Kit edits show up on the next build — there is no
  publish step. `OBSCURA_KIT_PATH` overrides the path.

  This replaced a mavenLocal dependency that resolved whatever jar was in
  `~/.m2`, drifted two months behind the kit, and turned API breaks into
  runtime surprises. The substitution in `settings.gradle.kts` must stay
  explicit: the kit declares `groupId` only inside its `publishing` block, so
  Gradle's automatic coordinate matching does not fire, and a bare
  `includeBuild` silently falls back to mavenLocal.

- Messages go through `client.send(recipientUserIds, …)` with a JSON payload of
  `{ conversationId, content }`, matching `directMessage` in
  `src/models/schema.ts`. `_authorUserId` is deliberately not sent — the app's
  drain stamps it from the envelope. `conversationId` must be the canonical
  sorted `userIdA_userIdB` form or the app's inbound authorization discards the
  entry.
