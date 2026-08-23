# Claude Code Context — obscura-pix

## What this is

The Obscura app: React Native (iOS + Android), with native platform layers in
the pinned `obscura-native` submodule (`kotlin/` and `swift/`).

**This repo is where the domain lives.** What a message is, what a pix is, who a write goes to,
what a notification says, how a conversation is rendered — all of it belongs here, in TypeScript,
written once.

The kits are **not** a framework. They are the native layer, and they exist for exactly two
reasons: libsignal ships only as `libsignal-java` / `libsignal-swift` (no supported shared core),
and background push processing cannot rely on a React Native runtime. Everything
that is not forced native by those constraints belongs in this repo.

The native boundary is
[`NATIVE_CONTRACT.md`](https://github.com/barrelmaker97/obscura-native/blob/a0d412b56e7104f55d788fd5babff844c313c3bb/docs/NATIVE_CONTRACT.md)
plus
[`KIT_API.md`](https://github.com/barrelmaker97/obscura-native/blob/a0d412b56e7104f55d788fd5babff844c313c3bb/docs/KIT_API.md).
Application-owned behavior is
normative in [`docs/DOMAIN_CONTRACT.md`](docs/DOMAIN_CONTRACT.md). Read all
three before changing anything that crosses the bridge.

The application-owned implementations are:

| Responsibility | File |
|---|---|
| Merge (`APPEND` / `REPLACE`) | `src/domain/merge.ts` |
| Canonical conversation id — construct and parse | `src/domain/conversation.ts` |
| Audience resolution | `src/domain/audience.ts` |
| Inbox classification, authorization, attribution, and merge | `src/domain/drain.ts` |
| Model declarations and their interpretation | `src/models/schema.ts` |
| Ordered storage/send/drain effects | `src/state/{drainInbox,writeEntry,store}.ts` |

`npm test` covers the domain, schema, native facade, and state layers. Renderer
behavior is outside that suite; see `jest.config.js`.

Nothing expires on either platform; `DOMAIN_CONTRACT.md` records that gap.

## The rule

> **If the kit reads it, it is a field in `client.proto`.
> If it is not in `client.proto`, the kit MUST NOT read it.**

If a task seems to need the kit to understand app data — a model name, a field name, a schema —
that is a boundary violation. Fix the proto or move the logic here. Never reach into the payload
from native.

## Identity: the second rule, and the one this app kept getting wrong

> **The envelope tells you who really sent this. The payload tells you what they chose to say.**

An inbox row carries `senderUserId` and `senderDeviceId`, both stamped by the server from a
device-scoped token and unforgeable by the sender (`NATIVE_CONTRACT.md` §0.10). Everything the app decides about
*who* — attribution, authorization, display names — resolves from those, never from a payload field.

- `src/domain/drain.ts` stamps `_authorUserId` from the envelope and **authorizes** the write:
  a `profile` may only be written to `profile_<senderUserId>`, and a conversation-scoped entry must
  name a canonical two-party conversation between this user and the actual sender.
- `src/utils/identity.ts` is the only place a userId becomes a name, and it reads the kit's friend
  graph.

**Delivery is not authorization**: any authenticated user can deliver to any
device (KIT_API §4.1), without friendship.

## What the app actually uses from the kit

Worth knowing, because it is much less than the kit provides. The full surface is
[`docs/BRIDGE.md`](docs/BRIDGE.md); this is the shape of it:

- **Inbox** — `inboxPeek` / `inboxConsume` / `inboxDiscard` / `inboxDepth`. How messages arrive.
- **Entries** — `entryPut` (a BLIND upsert: the app decides who wins) / `entryAll`. The store.
- **Send** — `sendEntry(recipientUserIds, …)`. The caller names the recipients.
- Signals: `sendTyping` / `stopTyping` / `observeTyping`. No read receipts.
- Auth, friends, device linking, attachments, push token registration.

Nothing in either direction parses a payload.

## The data model — `src/models/schema.ts`

Four models. This is the whole thing:

| Model | Merge | Audience | Authorization on inbound |
|---|---|---|---|
| `directMessage` | APPEND (dedupe by id) | conversation | conversation names self + sender |
| `story` | APPEND | all accepted friends | attribution only — nothing binds a story to an author |
| `pix` | REPLACE (the **recipient** writes `viewedAt`) | conversation | conversation names self + sender |
| `profile` | REPLACE | all accepted friends | id must be `profile_<senderUserId>` |

Notes for anyone tempted to reach for a CRDT: only `pix` and `profile` are mutable, and the merge
they need is a timestamp comparison with a device-id tie-break. `pix.viewedAt` is a
viewed-**receipt** wearing a CRDT costume.

## Known gaps

- **No expiry.** See the TTL note above. `story` is permanent on both platforms.
- **The outbox is durable but coarse.** A send that reached nobody marks the entry
  (`_undelivered`) and is retried on reconnect / foreground / cold start. What it does not do is
  track per-recipient delivery: a send that reached *some* recipients is best-effort and silent by
  the kit's design, so a partial failure is invisible here too.
- **iOS is build-gated, not production-gated.** CI builds the Swift bridge and React Native app for
  a simulator. Real APNs/background delivery and release signing still require physical-device
  validation.
- The Android package is consumed via a **Gradle composite build**
  (`android/settings.gradle` → `../obscura-native/kotlin`) and the Swift
  package via local SPM at `../obscura-native/swift`. Native revisions are
  pinned by the submodule gitlink and updated explicitly.

## Build

```bash
npm test
npm run typecheck
npm run lint
npm run android
```
