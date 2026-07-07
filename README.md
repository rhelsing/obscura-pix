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
- 24-hour stories
- Ephemeral photos (Pix) — encrypted, self-destructing
- Profiles synced to friends
- Private settings (never leave your device)
- Auto-reconnect, session persistence, offline delivery
- Push notifications (FCM)

The app never touches encryption, protobufs, or WebSocket frames. Everything goes through the ObscuraKit ORM.

## Architecture

```
React Native (shared UI, src/)
  └── Android: ObscuraBridgeModule.kt → ObscuraKit-Kotlin
```

Schema defined once in `src/models/schema.ts`. Both the Android bridge — and the future iOS bridge — read it, no hardcoded models on either platform. The bridge surface (methods + events) is documented in `docs/BRIDGE.md` and treated as the cross-platform contract.

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
  models/schema.ts        — ORM schema (single source of truth)
  native/ObscuraModule.ts — TypeScript bridge facade
  navigation/             — React Navigation root + types
  screens/                — UI screens
  state/store.ts          — Zustand store + useSession / useModelEntries hooks
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

## Dependencies

- [ObscuraKit-Kotlin](https://github.com/rhelsing/ObscuraKit-Kotlin) — Android E2E encrypted data layer
- [ObscuraKit-Swift](https://github.com/rhelsing/ObscuraKit-swift) — iOS E2E encrypted data layer (for the future iOS port)
- [obscura-server](https://github.com/barrelmaker97/obscura-server) — server (dumb relay, never sees contents)
