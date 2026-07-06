/**
 * Shared ORM schema — single source of truth for all platforms.
 * Both iOS and Android bridges cache this JSON on first defineModels() call
 * and use the cached copy for instant cold-start session restore.
 */
export const obscuraSchema = {
  directMessage: {
    fields: { conversationId: 'string', content: 'string', senderUsername: 'string' },
    sync: 'gset',
    // 1:1 — deliver to both conversation participants; never broadcast.
    audience: { kind: 'conversation', field: 'conversationId' },
  },
  story: {
    fields: {
      content: 'string',
      authorUsername: 'string',
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
    ttl: '24h',
  },
  profile: {
    fields: { displayName: 'string', bio: 'string?', avatarUrl: 'string?' },
    sync: 'lww',
  },
  settings: {
    fields: { theme: 'string', notificationsEnabled: 'boolean' },
    sync: 'lww',
    audience: { kind: 'self' }, // only ever synced to the user's own devices
  },
  pix: {
    fields: {
      // Canonical sorted "userIdA_userIdB" — targets both parties so the
      // viewed-receipt (Bob → Alice) resolves in either direction.
      conversationId: 'string',
      recipientUsername: 'string', // "to" label / push text only now
      senderUsername: 'string',
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
