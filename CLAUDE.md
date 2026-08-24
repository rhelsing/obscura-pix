# Obscura Pix

## Read first

- [`docs/DOMAIN_CONTRACT.md`](docs/DOMAIN_CONTRACT.md): application semantics.
- [`docs/BRIDGE.md`](docs/BRIDGE.md): React Native bridge behavior.
- [`NATIVE_CONTRACT.md`](https://github.com/barrelmaker97/obscura-native/blob/591a659/docs/NATIVE_CONTRACT.md):
  native ownership and receive guarantees.
- [`KIT_API.md`](https://github.com/barrelmaker97/obscura-native/blob/591a659/docs/KIT_API.md):
  app-facing native API.

## Ownership

- TypeScript owns models, payload parsing, recipients, authorization, merge,
  expiry, outbox policy, and rendering.
- ObscuraKit owns auth, friends/devices, Signal, transport, typing,
  attachments, durable inbox receipt, and opaque entry storage.
- Platform host code owns OS lifecycle, permissions, files, push,
  notifications, and bridge marshalling.

Do not move application semantics into native code.

> If a kit reads a value, it must be declared in `client.proto`.

> Sender identity comes from the envelope, never the payload.

## Application entry points

| Responsibility                   | File                          |
| -------------------------------- | ----------------------------- |
| Models                           | `src/models/schema.ts`        |
| Conversation IDs                 | `src/domain/conversation.ts`  |
| Audience                         | `src/domain/audience.ts`      |
| Authorization and drain planning | `src/domain/drain.ts`         |
| Merge                            | `src/domain/merge.ts`         |
| Inbox effects                    | `src/state/drainInbox.ts`     |
| Local write and send ordering    | `src/state/writeEntry.ts`     |
| Session and reactive state       | `src/state/store.ts`          |
| Native facade                    | `src/native/ObscuraModule.ts` |

## Checks

```bash
npm test
npm run typecheck
npm run lint
```

Rendered UI and physical-device behavior are outside the Jest suite.
