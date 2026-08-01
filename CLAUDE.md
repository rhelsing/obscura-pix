# Claude Code Context — obscura-pix

## What this is

The Obscura app: React Native (iOS + Android), with native platform layers underneath
(`ObscuraKit-Kotlin`, `ObscuraKit-swift`).

**This repo is where the domain lives.** What a message is, what a pix is, who a write goes to,
what a notification says, how a conversation is rendered — all of it belongs here, in TypeScript,
written once.

The kits are **not** a framework. They are the native layer, and they exist for exactly two
reasons: libsignal ships only as `libsignal-java` / `libsignal-swift` (no supported shared core),
and the push path must decrypt with the app closed (on iOS, in a Notification Service Extension,
which cannot run a React Native runtime). Everything that isn't forced native by one of those two
facts belongs in this repo.

The normative brief is [`obscura-proto/SPEC.md` §0 — The kit boundary](../obscura-proto/SPEC.md),
plus [`KIT_API.md`](../obscura-proto/KIT_API.md) §3 (the inbox), §4 (message kinds), §5 (send) and
§8 (what this means for pix). Read them before changing anything that crosses the bridge.

> **Status (2026-08-01): the move is done.** The ORM, CRDT engine, query DSL and audience-routing
> engine were deleted from **both** kits on 2026-07-31 (Kotlin #56, Swift #24), and pix's six ORM
> bridge wrappers went with them on 2026-07-30. Entry merge, audience resolution and inbox draining
> now exist **once**, here, in TypeScript:
>
> | Lives here | File |
> |---|---|
> | Merge (`APPEND` / `REPLACE`, SPEC §2.1–2.2, §2.4) | `src/domain/merge.ts` |
> | Audience resolution (SPEC §1.2–1.3) | `src/domain/audience.ts` |
> | Inbox drain: classify, authorize, attribute, merge (KIT_API §3, §4.1) | `src/domain/drain.ts` |
> | The effects those decisions drive | `src/state/{drainInbox,writeEntry,store}.ts` |
>
> **This repo has a test suite**: `npm test` runs 158 tests across 10 suites in about a second, with
> a dedicated `domain-tests` CI job. `src/domain` is at 100% coverage. What it still cannot cover is
> anything that RENDERS — see `jest.config.js`, which explains the renderer dependency honestly.
>
> **TTL did NOT move here.** Nothing expires on either platform: `TTLManager` went with the kits'
> engine and the `expiresAt` field the app would filter on (KIT_API §8.3) has not been built.
> `story` used to carry a `ttl: '24h'` that nothing read; it has been removed rather than left
> standing as a claim.

> **Why the boundary is written down.** An audit found a schema-driven ORM, CRDT engine, query
> DSL and audience-routing system implemented **twice** — in Kotlin and in Swift — to serve four
> flat models. This app used almost none of it. The deletion inventory is
> [`obscura-proto/RESET.md`](../obscura-proto/RESET.md), which is being retired now that it has
> been executed; cite `KIT_API.md` or `SPEC.md` in new work.
>
> The reason nobody noticed for months: the evidence lives *here*, and everyone (human and agent)
> was working *there*. An agent inside a kit repo cannot see that the engine is unnecessary. This
> file exists so that context is never missing again.

## The rule

> **If the kit reads it, it is a field in `client.proto`.
> If it is not in `client.proto`, the kit MUST NOT read it.**

If a task seems to need the kit to understand app data — a model name, a field name, a schema —
that is a boundary violation. Fix the proto or move the logic here. Never reach into the payload
from native.

## Identity: the second rule, and the one this app kept getting wrong

> **The envelope tells you who really sent this. The payload tells you what they chose to say.**

An inbox row carries `senderUserId` and `senderDeviceId`, both stamped by the server from a
device-scoped token and unforgeable by the sender (SPEC §0.10). Everything the app decides about
*who* — attribution, authorization, display names — resolves from those, never from a payload field.

- `src/domain/drain.ts` stamps `_authorUserId` from the envelope and **authorizes** the write:
  a `profile` may only be written to `profile_<senderUserId>`, and a conversation-scoped entry must
  name a canonical two-party conversation between this user and the actual sender.
- `src/utils/identity.ts` is the only place a userId becomes a name, and it reads the kit's friend
  graph.

This was a live defect until 2026-08-01: the drain did not copy `senderUserId` at all, and every
screen answered "who is this from" with `senderUsername` / `authorUsername` / `recipientUsername`,
which the sender picks. **Delivery is not authorization** — any authenticated user can deliver to
any device (KIT_API §4.1), friendship not required.

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

`settings` was deleted 2026-08-01 (zero references in `src/`, per KIT_API §4.3).

## Known gaps

- **No expiry.** See the TTL note above. `story` is permanent on both platforms today.
- **The outbox is durable but coarse.** A send that reached nobody marks the entry
  (`_undelivered`) and is retried on reconnect / foreground / cold start. What it does not do is
  track per-recipient delivery: a send that reached *some* recipients is best-effort and silent by
  the kit's design, so a partial failure is invisible here too.
- **No iOS CI job.** The workflow is `typecheck`, `domain-tests`, `lint`, `android`. The Swift
  bridge and this repo's one shared TypeScript surface can diverge without anything going red.
- The Android kit is consumed via a **Gradle composite build** (`android/settings.gradle` →
  `../../ObscuraKit-Kotlin`) and the Swift kit via a **local SPM package**. Kit changes land
  immediately — there is no version-bump buffer.

## Build

```bash
npm test          # 158 tests, ~1s
npm run typecheck
npm run lint
npm run android
```
