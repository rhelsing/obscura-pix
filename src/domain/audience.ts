/**
 * Who an entry goes to (`obscura-proto/SPEC.md` §0.4, §1.2).
 *
 * This is the third piece of domain logic to move out of the kits, after `merge.ts` and `drain.ts` —
 * and the one that carries the most risk, because getting it wrong sends private content to people
 * who should not have it.
 *
 * ## Why the app owns this now
 *
 * SPEC §0.4: **the caller names the recipients.** The kit's `send` fans out to exactly the userIds
 * it is given and resolves nothing of its own, so the resolution has to live here — the only place
 * that knows what a `conversationId` is, or that `recipientUsername` names a person.
 *
 * ## Fail loud, and fail SAFE
 *
 * Two different rules, and the difference is the whole point:
 *
 * - **Fail loud** — an audience that cannot be resolved raises. It never falls back to "everyone".
 *   An unresolvable audience widening into a broadcast is the exact shape of the typing-indicator
 *   leak found on 2026-07-25: a 1:1 payload, an audience nobody resolved, delivered to every friend.
 * - **Fail safe** — naming someone who is not a friend resolves to *self only*, not to an error and
 *   not to everyone. The user asked for a narrow audience; the narrowest honest answer is nobody
 *   else.
 *
 * ## Provenance
 *
 * The five guards below are vendored from `obscura-proto/conformance/routing.json`, which was
 * handed over to this repo and then deleted on 2026-07-31 (SPEC §1, "the five leak guards live in
 * `obscura-pix/src/domain/__tests__/audience.guards.test.ts`"): the kits stopped resolving
 * audiences, so the vectors stopped being a cross-implementation contract and became this file's
 * fixture. `__tests__/audience.guards.test.ts` runs them verbatim. The other five routing cases
 * retired with the engine — they pinned resolution behaviour that no longer exists in two places.
 */

/** A friend, as the audience resolver needs them. */
export interface AudienceFriend {
  userId: string;
  username: string;
  status: string;
}

/**
 * How a model's schema declares who its entries reach.
 *
 * There is deliberately no `{ kind: 'friends' }`: "every accepted friend" is what `undefined` means
 * (see `resolveAudience`), so a second spelling of it was a branch no model declared and no test
 * reached.
 */
export type AudienceConfig =
  | { kind: 'conversation'; field: string }
  | { kind: 'recipient'; field: string }
  | { kind: 'self' };

/**
 * Raised when an audience cannot be resolved.
 *
 * The name matches the kits' `ObscuraError.DirectRoutingUnresolved` and `routing.json`'s expected
 * error, deliberately: this rule did not change when it moved, only its address did.
 */
export class DirectRoutingUnresolved extends Error {
  readonly code = 'DIRECT_ROUTING_UNRESOLVED';

  constructor(reason: string) {
    super(`Refusing to send: ${reason}`);
    this.name = 'DirectRoutingUnresolved';
  }
}

/**
 * The userIds an entry must reach, **excluding** this device's own user.
 *
 * Self is deliberately not in the result. The kit self-syncs to the author's *other* devices as part
 * of `send`, so including the author here would be a second, redundant fan-out — and `routing.json`
 * expresses expectations with self included, which is why the guard tests add it back before
 * comparing rather than this function returning it.
 *
 * @throws DirectRoutingUnresolved when the audience cannot be determined.
 */
export function resolveAudience(
  audience: AudienceConfig | undefined,
  data: Record<string, unknown>,
  selfUserId: string,
  friends: readonly AudienceFriend[],
): string[] {
  const accepted = friends.filter((f) => f.status === 'accepted');

  // No declared audience is "all accepted friends" — the historical default for `story` and
  // `profile`, both of which are genuinely broadcast-to-friends models.
  if (audience === undefined) return accepted.map((f) => f.userId).filter((id) => id !== selfUserId);

  switch (audience.kind) {
    case 'self':
      // Own devices only. The kit's self-sync covers it, so there is no one else to name.
      return [];

    case 'conversation': {
      const raw = data[audience.field];
      if (typeof raw !== 'string' || raw.length === 0) {
        // GUARD: a missing conversation id must fail loud. The tempting fallback — "no id, so send
        // to everyone" — is precisely how a 1:1 payload becomes a broadcast.
        throw new DirectRoutingUnresolved(
          `'${audience.field}' is missing or empty, so the conversation audience cannot be resolved`,
        );
      }
      // NOTE the constraint this format imposes: **a userId must not contain `_`**. Server-issued
      // ids are UUIDs (hyphens, no underscores), and both kits split the same way, so this holds
      // today — but it is an assumption, not a guarantee, and it is silent when violated. It fails
      // in the SAFE direction at least: an id with an extra `_` yields the wrong participant count
      // and refuses, rather than resolving to a wrong or wider audience.
      //
      // SPEC §1.3 is exact: splitting on `_` MUST yield **exactly two non-empty parts**. So count
      // first and require non-empty second — filtering the empties out *before* counting (as this
      // did until 2026-08-01) accepts `uA__uB`, `_uA_uB`, `uA_uB_` and `__uA___uB__` as two-party.
      // Nothing covered it either way: deleting the filter left the whole suite green.
      const participants = raw.split('_');
      if (participants.length !== 2 || participants.some((p) => p.length === 0)) {
        // GUARD: the named failure mode. A canonical conversation id has exactly two participants;
        // anything else is not a conversation this app knows how to address, and guessing widens it.
        throw new DirectRoutingUnresolved(
          `'${raw}' is not a canonical two-party conversation id (${participants.length} parts)`,
        );
      }
      // GUARD: **I must be one of the two participants.** The intersection below cannot widen past
      // my friends, but without this it happily resolves a conversation between two *other* people
      // to both of them — `resolveAudience(CONVERSATION, {conversationId:'uA_uB'}, 'uMe', …)`
      // returned `['uA','uB']`, two external recipients in a conversation I am not in.
      //
      // Reachable end-to-end: `StoriesScreen` echoes a viewed pix back to its own `conversationId`,
      // and that id came from a peer's payload. An id that does not name me is not a conversation I
      // am in, so SPEC §1.2's fail-loud rule applies — this audience cannot be resolved.
      if (!participants.includes(selfUserId)) {
        throw new DirectRoutingUnresolved(
          `'${raw}' does not name this user, so it is not a conversation this device can address`,
        );
      }
      // GUARD, and the one that was missing: **the participants are intersected with the accepted
      // friend graph.** A conversation id is a payload field, so without this the app sends to
      // whatever userId a peer wrote into it.
      //
      // That is reachable, not theoretical. `StoriesScreen` writes a viewed-receipt back with
      // `{ ...story.data }`, and `story.data.conversationId` came from a peer's ModelSync. Any
      // authenticated user can deliver to any device (friendship is not required to send, KIT_API
      // §4.1), so a stranger could push a `pix` naming `<me>_<userId of their choosing>` and my
      // device would mail the entry — `mediaRef`, `contentKey`, `nonce`, `caption` — to that userId
      // when I viewed it. A hostile friend could redirect an entry I already hold by replaying it
      // with a higher `sentAt`.
      //
      // Fails SAFE, matching the `recipient` branch below: an unreachable participant is dropped
      // rather than raising, so a conversation with someone I have unfriended stops sending instead
      // of erroring. It cannot widen — the intersection only ever removes.
      const acceptedIds = new Set(accepted.map((f) => f.userId));
      return participants.filter((id) => id !== selfUserId && acceptedIds.has(id));
    }

    case 'recipient': {
      const raw = data[audience.field];
      if (typeof raw !== 'string' || raw.length === 0) {
        // GUARD: missing or blank. Blank is not "everyone" — it is an unanswered question.
        throw new DirectRoutingUnresolved(
          `'${audience.field}' is missing or blank, so the recipient cannot be resolved`,
        );
      }
      const friend = accepted.find((f) => f.username === raw);
      // GUARD, and this one fails SAFE rather than loud: naming a non-friend resolves to nobody
      // else. The user named a narrow audience we cannot reach; the narrowest honest answer is an
      // empty list, which the kit turns into a self-sync. Never a broadcast.
      return friend === undefined || friend.userId === selfUserId ? [] : [friend.userId];
    }
  }
}
