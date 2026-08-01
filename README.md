# Obscura Pix

End-to-end encrypted photo messaging app. Signal Protocol encryption, disappearing content. Built on ObscuraKit.

React Native app, **Android-only in production today**. A working iOS foundation
(RN scaffold + Swift bridge on [ObscuraKit-swift](https://github.com/rhelsing/ObscuraKit-swift))
is committed under `ios/` and runs on the simulator, but is not yet reproducibly
buildable or CI-gated — see [`docs/IOS_PARITY.md`](docs/IOS_PARITY.md). Its bridge
implements the contract documented in [`docs/BRIDGE.md`](docs/BRIDGE.md).

## What it does

- Friends via shareable codes
- Encrypted chat with typing indicators
- Stories (posted to all friends; **they do not expire yet** — see `ROADMAP.md`)
- Ephemeral photos (Pix) — encrypted, view-once
- Profiles synced to friends
- Auto-reconnect, session persistence, offline delivery
- Push notifications (FCM)

The app never touches encryption, protobufs, or WebSocket frames. Those are the kit's, and they are
the *only* thing the kit does: it is a durable, authenticated inbox and outbox for bytes it cannot
read. Everything about what those bytes mean — merge, audience, drain, identity, rendering — lives
in `src/`, in TypeScript, written once. See [`CLAUDE.md`](CLAUDE.md).

## Architecture

```
React Native (shared UI, src/)
  └── Android: ObscuraBridgeModule.kt → ObscuraKit-Kotlin
```

Model semantics are defined once in `src/models/schema.ts` and read by the **app alone** — the kit
no longer parses an application schema (`SPEC.md` §0.4), so nothing about a model crosses the
bridge. The bridge surface (methods + events) is documented in `docs/BRIDGE.md` and treated as the
cross-platform contract.

## Setup

### Prerequisites

- Node 22.11+, React Native CLI
- Android Studio, JDK 21

### Install + run

```bash
npm install
npx react-native run-android
```

A Firebase `google-services.json` is required for FCM; place it at `android/app/google-services.json` (gitignored).

## Project Structure

```
src/
  domain/                 — the app's logic, pure and fully tested
    merge.ts              — APPEND / REPLACE (SPEC §2.1-2.2, §2.4)
    audience.ts           — who a write goes to (SPEC §1.2-1.3)
    drain.ts              — classify, authorize, attribute, merge an inbox batch
  state/                  — the effects those decisions drive
    drainInbox.ts         — peek → write → consume | discard
    writeEntry.ts         — store locally, then send; the durable outbox
    store.ts              — Zustand store + useSession / useModelEntries hooks
  models/schema.ts        — model semantics (app-only; never crosses the bridge)
  native/ObscuraModule.ts — TypeScript bridge facade
    __fixtures__/         — the in-memory kit double the tests run against
  utils/identity.ts       — userId → display name, from the friend graph only
  navigation/             — React Navigation root + types
  screens/                — UI screens
android/
  app/src/main/java/com/obscuraapp/
    ObscuraBridgeModule.kt — Bridge: JS ↔ ObscuraKit-Kotlin
    ObscuraSession.kt      — Process-scoped owner of the kit client
    ObscuraMessagingService.kt — FCM silent-push receiver
    NotificationHelper.kt  — Local notification posting
docs/
  BRIDGE.md               — Cross-platform bridge contract (iOS implements this)
tools/push-sender/        — Kotlin CLI for triggering test pushes
App.tsx                   — Providers + navigator
```

## Development

Native events push reactively to JS — no polling. Friends, connection state, auth state, typing, and incoming messages all flow through `onObscuraEvent` from `src/native/ObscuraModule.ts`. The Zustand store at `src/state/store.ts` subscribes once and fans out to screens via `useSession()` and `useModelEntries(model)`.

JS changes hot-reload via Metro. Native (Kotlin) changes require a rebuild.

`npm test` runs the Node-side suite — `src/domain`, `src/native` and `src/state` against the
in-memory kit double — in about a second, and CI runs it on every PR. Anything that RENDERS is out
of scope for it; `jest.config.js` explains why.

## Dependencies

- [ObscuraKit-Kotlin](https://github.com/rhelsing/ObscuraKit-Kotlin) — Android E2E encrypted data layer
- [ObscuraKit-Swift](https://github.com/rhelsing/ObscuraKit-swift) — iOS E2E encrypted data layer (for the future iOS port)
- [obscura-server](https://github.com/barrelmaker97/obscura-server) — server (dumb relay, never sees contents)
