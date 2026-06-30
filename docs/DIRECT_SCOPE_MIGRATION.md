# obscura-pix: adopt the `direct` sync scope (exact steps)

## Why
1:1 payloads (`directMessage`, `pix`) currently fall through to **broadcast-to-all-friends** in
the ORM sync layer — the recipient set is literally who the payload gets Signal-encrypted and
sent to, so every mutual friend receives a decryptable copy. The kits now support a `direct`
scope that resolves an explicit recipient or **fails closed** (never broadcasts). This note is
exactly what to change in obscura-pix to use it.

## ⚠️ The one gotcha: `pix` is bidirectional
- **Send** (`RecipientPicker.tsx`): Alice creates a pix with `recipientUsername: bob`.
- **Viewed-receipt** (`StoriesScreen.tsx` `markCurrentViewed`): Bob upserts the *same* pix with
  `viewedAt`, spreading `...story.data`, so `recipientUsername` is still `bob`. The receipt must
  travel **back to Alice**.

`recipientUsername` is one-directional, so naive `direct` resolution (recipient = `recipientUsername`)
makes Bob's receipt resolve to "is bob my friend? no" → sent to no one → **Alice never sees
"viewed".** It only works today because of the broadcast leak.

**Fix: give `pix` a `conversationId` (both party userIds) and target on that** — the same field
`directMessage` already uses. The kit's 2-party `conversationId` resolution already works in both
directions and is already tested, so this adds **no new kit logic**. Keep `recipientUsername` for
the "to" label / push text.

---

## Architecture (so the changes make sense)
`src/models/schema.ts` (JSON) → `Obscura.defineModels(json)` →
- **Android**: `android/app/src/main/java/com/obscuraapp/ObscuraSession.kt#defineModelsFromJson`
  builds `ModelConfig`.
- **iOS**: bridge calls the kit's `client.defineModelsFromJson(json)` which builds `ModelDefinition`.

## Kit prerequisites (bump these first)
- **Kotlin kit** (`obscura-client-kotlin`): `ModelConfig.direct` is **merged to `main`**
  (was `fix/sync-targeting-1to1`). Bump the `obscura-client-kotlin` dependency to a build off `main`.
- **iOS kit** (`ObscuraKit-swift`): the `.direct` SyncScope **and** the JSON mapping
  (`"direct": true` → `.direct`) are **merged to `main`**. Bump the SPM dep.

Both kits now support `direct` on `main`; the remaining work below is entirely in obscura-pix.

---

## Changes

### 1. `src/models/schema.ts` — declare scope on the two 1:1 models
```ts
directMessage: {
  fields: { conversationId: 'string', content: 'string', senderUsername: 'string' },
  sync: 'gset',
  direct: true,                         // ADD
},

pix: {
  fields: {
    conversationId: 'string',           // ADD — sorted "userIdA_userIdB" (targeting)
    recipientUsername: 'string',        // keep — used for "to" label / push text only now
    senderUsername: 'string',
    mediaRef: 'string',
    contentKey: 'string',
    nonce: 'string',
    caption: 'string?',
    displayDuration: 'number',
    viewedAt: 'number?',
  },
  sync: 'lww',
  direct: true,                         // ADD
},
```
(`story`, `profile`, `settings` are unchanged — story/profile stay broadcast, settings stays `private`.)

### 2. `src/screens/RecipientPicker.tsx` — set the pix `conversationId` at send time
`myUserId` is already on `useSession()`; `conversationId(myUserId, friendUserId)` already exists
(`src/native/ObscuraModule.ts`) and is what `ChatScreen` uses.
```ts
import { Obscura, conversationId } from '../native/ObscuraModule';   // add conversationId
const { friends, myUsername, myUserId } = useSession();              // add myUserId

for (const friend of recipients) {
  await Obscura.createEntry('pix', {
    conversationId: conversationId(myUserId, friend.userId),         // ADD
    recipientUsername: friend.username,
    senderUsername: myUsername,
    mediaRef: attachment.id,
    contentKey: attachment.contentKey,
    nonce: attachment.nonce,
    caption,
    displayDuration,
  });
}
```
`StoriesScreen.tsx` `markCurrentViewed` needs **no change** — it spreads `...story.data`, which now
carries `conversationId`, so the viewed-receipt resolves to the other party automatically.

### 3. `android/app/src/main/java/com/obscuraapp/ObscuraSession.kt` — read `direct` from JSON
Around line 257, add one line to the `ModelConfig(...)`:
```kotlin
models[name] = ModelConfig(
    fields = fields,
    sync = model.optString("sync", "gset"),
    ttl = if (model.has("ttl") && !model.isNull("ttl")) model.getString("ttl") else null,
    private = model.optBoolean("private", false),
    direct = model.optBoolean("direct", false),     // ADD
)
```

### 4. iOS bridge — no change
`ObscuraBridge.swift` already calls `client.defineModelsFromJson(json)`, and the kit now maps
`"direct": true` → `.direct`. Just bump the kit dependency.

---

## Verify (do not trust the happy path alone)
Use **three** mutual friends — A, B, C all friends with each other.

1. **DM leak**: A sends B a `directMessage`. Assert **C never receives it** (check C's entries /
   logs). Repeat A→B `pix`.
2. **Pix viewed-receipt (the gotcha)**: A sends B a pix; B opens it (fires `viewedAt`); assert **A
   sees "viewed"** and **C receives nothing** in either direction.
3. **Story still broadcasts**: A posts a story → both B and C receive it.
4. **Fail-loud**: confirm a direct entry with a missing/garbled `conversationId` does **not**
   broadcast (Kotlin throws from `create()`; iOS logs `SYNC: refusing to broadcast direct …` and
   sends self-only). Check the kit debug log.
5. **Kit unit tests** (deterministic, no server): `SyncTargetingTests` exists in both kits —
   `./gradlew :lib:test --tests "scenarios.SyncTargetingTests"` and `swift test --filter SyncTargetingTests`.

## Checklist of things that might bite
- [ ] Both conversation participants must define the **same** schema (already true — shared `schema.ts`).
- [ ] Any receive-side `recipientUsername == me` display filter still behaves (now redundant since
      only real recipients receive the pix, but confirm it doesn't hide the sender's own copy).
- [ ] `conversationId` must be the canonical sorted, single-underscore `"idA_idB"`. Don't invent
      separators — the kit splits on `_` and a non-2-part id triggers fail-loud.
- [ ] Web client (`obscura-client-web`) has the same leak and is **not** patched — separate task.

## Decision for you
This note recommends giving `pix` a `conversationId` (reuses the existing, tested 2-party
resolution; no new kit code). The alternative — keep `recipientUsername`-only and change the kits
to target {sender, recipient} — avoids the pix schema field but adds shared-kit logic on both
platforms and needs re-testing. I'd take the `conversationId` route unless you have a reason not to.
