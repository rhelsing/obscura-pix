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

The normative brief is [`obscura-proto/SPEC.md` §0 — The kit boundary](../obscura-proto/SPEC.md).
Read it before changing anything that crosses the bridge.

> **Why the boundary is written down.** An audit found a schema-driven ORM, CRDT engine, query
> DSL and audience-routing system implemented **twice** — in Kotlin and in Swift — to serve the
> five flat models in `src/models/schema.ts`. This app uses almost none of it. The deletion
> inventory is [`obscura-proto/RESET.md`](../obscura-proto/RESET.md).
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

## What the app actually uses from the kit

Worth knowing, because it is much less than the kit provides:

- **ORM: four calls** — `defineModels`, `createEntry`, `upsertEntry`, `allEntries`.
  Reads are event → refetch-everything (`src/state/store.ts`), filtered client-side in zustand.
- `queryEntries` and `deleteEntry` are exposed on the bridge and have **zero callers**. The kit's
  query DSL, relationships, `include()`, tombstones and reactive entry-observation are unreachable.
- Signals: `sendTyping` / `stopTyping` / `observeTyping`. No read receipts.
- Auth, friends, device linking, attachments, push token registration.

## The data model — `src/models/schema.ts`

Five models. This is the whole thing:

| Model | Written by | Merge actually needed |
|---|---|---|
| `directMessage` | `createEntry` | append (dedupe by id) |
| `story` | `createEntry` | append + expiry |
| `pix` | `createEntry`, then `upsertEntry` (the **recipient** writes `viewedAt`) | replace (higher timestamp wins) |
| `profile` | `upsertEntry` | replace |
| `settings` | **never written** | — (delete it) |

Notes for anyone tempted to reach for a CRDT: only `pix` and `profile` are mutable, and the merge
they need is a timestamp comparison. `pix.viewedAt` is a viewed-**receipt** wearing a CRDT costume.

## Known issues

- **No test suite.** CI runs `tsc`, `eslint`, and an Android release build. Compile breaks are
  caught; every semantic regression is not.
- `senderUsername` / `authorUsername` / `recipientUsername` are **sender-supplied display names**
  carried in the payload — a peer chooses how they are labelled on your screen. Per SPEC §0.5 a
  name must be resolved from the local friend graph, keyed on the authenticated envelope.
- The Android kit is consumed via a **Gradle composite build** (`android/settings.gradle` →
  `../../ObscuraKit-Kotlin`) and the Swift kit via a **local SPM package**. Kit changes land
  immediately — there is no version-bump buffer.

## Build

```bash
npm run typecheck
npm run lint
npm run android
```
