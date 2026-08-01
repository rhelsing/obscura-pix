/**
 * The app's model semantics — the single source of truth for what a model *means*.
 *
 * Read by the APP, not by the kit: `drainInbox` takes each model's `sync` strategy as a merge rule
 * plus its authorization rule, and `writeEntry` takes its `audience`. It no longer crosses the
 * bridge — the kit does not parse application schemas (SPEC §0.4).
 *
 * ## Identity is never a payload field
 *
 * There is deliberately no `senderUsername` / `authorUsername` / `recipientUsername` here. A
 * payload-supplied name is attacker-chosen (SPEC §0.5, §0.10 rule 5): a stranger who sent
 * `{ authorUsername: "alice" }` appeared in the feed as Alice. Attribution comes from the
 * **authenticated** envelope instead, stamped into `_authorUserId` by the drain (for entries that
 * arrive) and by `writeEntry` (for entries this device creates), and display names are resolved
 * from the friend graph at render time so a rename is reflected rather than frozen.
 *
 * `fields` is documentation now — nothing parses it — but `_authorUserId` is listed on every model
 * because it is the field the screens key on.
 */

/** App-owned metadata on every stored entry: the authenticated userId of whoever created it. */
export const AUTHOR_USER_ID = '_authorUserId';

/**
 * A `profile` entry's id is derived from its owner, which is what makes the entry authorizable:
 * only `<userId>` may write `profile_<userId>` (see `drain.ts`). Kept here so the one place that
 * mints the id and the one place that checks it cannot drift.
 */
export const PROFILE_ID_PREFIX = 'profile_';
export function profileEntryId(userId: string): string {
  return PROFILE_ID_PREFIX + userId;
}

export const obscuraSchema = {
  directMessage: {
    fields: { conversationId: 'string', content: 'string', _authorUserId: 'string' },
    sync: 'gset',
    // 1:1 — deliver to both conversation participants; never broadcast.
    audience: { kind: 'conversation', field: 'conversationId' },
  },
  story: {
    fields: {
      content: 'string',
      _authorUserId: 'string',
      // Attachment fields — present iff the story has a photo (text-only stories
      // omit all three). Same shape as pix so a single viewer can render both.
      mediaRef: 'string?',
      contentKey: 'string?',
      nonce: 'string?',
      // 'photo' (default when absent) | 'video'. Opaque string.
      mediaType: 'string?',
      // Styled-caption blob (JSON: style/x/y/rot/color/font). Opaque string —
      // the shape can evolve without a schema/contract change. See Caption.tsx.
      captionMeta: 'string?',
    },
    sync: 'gset',
    // NO `ttl`. Stories do not expire on either platform: `TTLManager` went with the kits' engine
    // and the `expiresAt` field the app would filter on (KIT_API §8.3) has not been built. A `ttl`
    // key nothing reads was a claim, not a feature.
  },
  profile: {
    fields: { displayName: 'string', bio: 'string?', avatarUrl: 'string?', _authorUserId: 'string' },
    sync: 'lww',
    // The id binds the entry to its owner: only `<userId>` may write `profile_<userId>`. Without
    // this a stranger's REPLACE write with a higher `sentAt` overwrote the row `ProfileScreen`
    // reads and re-broadcast, so their text went out to my friends under my name.
    ownerIdPrefix: PROFILE_ID_PREFIX,
  },
  pix: {
    fields: {
      // Canonical sorted "userIdA_userIdB" — targets both parties so the
      // viewed-receipt (Bob → Alice) resolves in either direction.
      conversationId: 'string',
      _authorUserId: 'string',
      mediaRef: 'string',
      contentKey: 'string',
      nonce: 'string',
      caption: 'string?',
      // 'photo' (default when absent) | 'video'. Opaque string.
      mediaType: 'string?',
      // Styled-caption blob (JSON: style/x/y/rot/color/font). Opaque string —
      // the shape can evolve without a schema/contract change. See Caption.tsx.
      captionMeta: 'string?',
      displayDuration: 'number',
      viewedAt: 'number?',
    },
    sync: 'lww',
    // 1:1 — deliver to both conversation participants so the viewed-receipt
    // (recipient → sender) resolves in either direction; never broadcast.
    audience: { kind: 'conversation', field: 'conversationId' },
  },
};
