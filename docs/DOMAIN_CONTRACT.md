# Application domain contract

This document defines the application-owned behavior implemented once in
`src/domain/`, `src/models/`, and `src/state/`. Native transport and storage APIs
are defined by
[`obscura-native/docs/KIT_API.md`](https://github.com/barrelmaker97/obscura-native/blob/b776161/docs/KIT_API.md).

## Ownership

The application owns:

- model schemas and payload parsing;
- recipient and audience resolution;
- inbound authorization;
- merge and conflict resolution;
- expiry, queries, filters, and sorting; and
- notification policy and copy.

The native layer receives and stores opaque payload bytes. It does not inspect
application fields or model names.

## Models

| Model | Merge | Audience | Inbound authorization |
|---|---|---|---|
| `directMessage` | APPEND | conversation | conversation names self and sender |
| `story` | APPEND | all accepted friends | transport-attributed sender is the author |
| `pix` | REPLACE | conversation | conversation names self and sender |
| `profile` | REPLACE | all accepted friends | ID is `profile_<senderUserId>` |

`src/models/schema.ts` is the executable source of these declarations and of the
accessors that interpret them: `audienceFor(model)` for the send side and
`modelRules()` for the drain.

## Audience resolution

The app passes explicit recipient user IDs to the native send API. Resolution
MUST fail without sending when a required recipient or conversation value is
missing or malformed. It MUST NOT widen an unresolved audience to a broadcast.

- An undeclared audience means every accepted friend.
- `self` means own other devices only; the external recipient list is empty.
- A recipient username resolves only through the accepted-friend graph. An
  unknown name resolves to no external recipient.
- A conversation value names exactly two non-empty user IDs, includes the local
  user, and is intersected with the accepted-friend graph.

### Canonical conversation ID

The canonical ID is the two participant user IDs sorted lexicographically and
joined with one underscore: `"userIdA_userIdB"`. Server-issued user IDs are
UUIDs and therefore contain no underscore.

The sender constructs this canonical form. Validation MUST reject a reversed or
otherwise noncanonical form rather than guessing an audience.

`src/domain/conversation.ts` is the executable source of this format: one
constructor and one parser, shared by the send and receive validations.

`DIRECT_ROUTING_UNRESOLVED` is the stable application error for a required
audience that cannot be resolved.

## Inbound authorization

Delivery is not authorization: any authenticated account may address a device.
The drain authorizes a write using the inbox row's transport identity, never a
payload-supplied identity.

- A remote conversation entry must name the local user and `senderUserId`.
- A self-sync conversation entry (`senderUserId` is the local user) must name
  the local user; its other participant is the conversation peer.
- A profile entry ID must equal `profile_<senderUserId>`.
- Story attribution uses `senderUserId`; story payloads have no separate
  author-binding field.
- Display names are resolved later from the local friend graph.

Permanent rejection uses `inboxDiscard(ids, reason)` and is logged as deliberate
data loss.

## Merge

Merge is keyed by entry ID and MUST be idempotent because a crash after entry
storage but before inbox consumption replays the row.

### APPEND

The first write for an entry ID wins. Later repeats are ignored.

### REPLACE

The highest total-order tuple `(sentAt, authorDeviceId)` wins:

1. greater `sentAt`;
2. on equal `sentAt`, lexicographically greater `authorDeviceId`; and
3. equality on both is the same logical write.

`authorDeviceId` is supplied by the native layer from the decrypting Signal
session. Incoming timestamps are clamped by the native receive path before
merge.

## Drain ordering

The effect order is:

```text
peek -> decode/classify -> authorize -> merge -> entryPut -> consume
```

Rows that can never be processed are discarded with a reason. Transient rows
remain pending. Entry writes and inbox deletion do not share a transaction, so
all merge behavior must tolerate replay.

## Expiry

Nothing expires automatically. Stories and entries remain until application
storage behavior explicitly implements and tests expiry.

## Current gaps

- Partial-recipient delivery is not observable to the application.
- No distributed delete or expiry behavior exists.
