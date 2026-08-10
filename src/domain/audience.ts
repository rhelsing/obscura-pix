/**
 * Who an entry goes to (`docs/DOMAIN_CONTRACT.md`).
 *
 * The domain contract requires the caller to name recipients. The kit fans out to
 * exactly those user ids and does not interpret application model fields.
 *
 * - **Fail loud** — an audience that cannot be resolved raises. It never falls back to "everyone".
 * - **Fail safe** — naming someone who is not a friend resolves to *self only*, not to an error and
 *   not to everyone. The user asked for a narrow audience; the narrowest honest answer is nobody
 *   else.
 */

import { parseConversationId } from './conversation';

/** A friend, as the audience resolver needs them. */
export interface AudienceFriend {
  userId: string;
  username: string;
  status: string;
}

/**
 * How a model's schema declares who its entries reach.
 *
 * There is no `{ kind: 'friends' }`: `undefined` means every accepted friend.
 */
export type AudienceConfig =
  | { kind: 'conversation'; field: string }
  | { kind: 'recipient'; field: string }
  | { kind: 'self' };

/**
 * Raised when an audience cannot be resolved.
 *
 * The code is shared with bridge-facing error handling.
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
 * Self is not in the result because the kit self-syncs to the author's other
 * devices as part of `send`.
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
      // FORMAT, owned by `conversation.ts` and shared with the receive side so the two directions
      // cannot disagree about what a conversation id is.
      const participants = parseConversationId(raw);
      if (participants === null) {
        // GUARD: the named failure mode. A canonical id is exactly two participants in the order the
        // constructor produces; anything else is not a conversation this app knows how to address,
        // and guessing widens it.
        throw new DirectRoutingUnresolved(
          `'${raw}' is not a canonical two-party conversation id ` +
            '(expected two non-empty user ids, sorted, joined by a single underscore)',
        );
      }
      // GUARD: **I must be one of the two participants.** The intersection below cannot widen past
      // my friends, but without this it happily resolves a conversation between two *other* people
      // to both of them — `resolveAudience(CONVERSATION, {conversationId:'uA_uB'}, 'uMe', …)`
      // returned `['uA','uB']`, two external recipients in a conversation I am not in.
      //
      // Reachable end-to-end: `StoriesScreen` echoes a viewed pix back to its own `conversationId`,
      // and that id came from a peer's payload. An id that does not name me is not a conversation I
      // am in, so the fail-loud rule applies — this audience cannot be resolved.
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
